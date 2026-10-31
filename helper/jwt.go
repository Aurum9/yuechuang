package main

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"time"
)

type identity struct{ Subject, Issuer, Email string }
type jsonWebKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

func invalidIdentity() error {
	return failure("identityValidationFailed", "OpenAI 身份凭证校验失败，原账号凭证已保留。请重新登录。")
}
func (a *app) validateIDToken(ctx context.Context, token, clientID, nonce string, requireNonce bool) (identity, error) {
	var result identity
	if len(token) == 0 || len(token) > 128*1024 {
		return result, invalidIdentity()
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return result, invalidIdentity()
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return result, invalidIdentity()
	}
	var header struct {
		Alg  string   `json:"alg"`
		Kid  string   `json:"kid"`
		Crit []string `json:"crit"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || header.Kid == "" || len(header.Crit) != 0 || (header.Alg != "RS256" && header.Alg != "PS256" && header.Alg != "ES256") {
		return result, invalidIdentity()
	}
	discovery, err := a.discover(ctx)
	if err != nil {
		return result, err
	}
	var keys struct {
		Keys []jsonWebKey `json:"keys"`
	}
	if err = a.getJSON(ctx, discovery.JWKSURI, &keys); err != nil {
		return result, err
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return result, invalidIdentity()
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	valid := false
	for _, key := range keys.Keys {
		if key.Kid != header.Kid || (key.Use != "" && key.Use != "sig") || (key.Alg != "" && key.Alg != header.Alg) {
			continue
		}
		if (header.Alg == "RS256" || header.Alg == "PS256") && key.Kty == "RSA" {
			n, e1 := base64.RawURLEncoding.DecodeString(key.N)
			e, e2 := base64.RawURLEncoding.DecodeString(key.E)
			if e1 != nil || e2 != nil || len(e) == 0 || len(e) > 4 {
				continue
			}
			exponent := 0
			for _, b := range e {
				exponent = exponent*256 + int(b)
			}
			modulus := new(big.Int).SetBytes(n)
			if modulus.BitLen() < 2048 || exponent < 3 || exponent%2 == 0 {
				continue
			}
			pub := rsa.PublicKey{N: modulus, E: exponent}
			if header.Alg == "RS256" {
				valid = rsa.VerifyPKCS1v15(&pub, crypto.SHA256, digest[:], signature) == nil
			} else {
				valid = rsa.VerifyPSS(&pub, crypto.SHA256, digest[:], signature, &rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: crypto.SHA256}) == nil
			}
		} else if header.Alg == "ES256" && key.Kty == "EC" && key.Crv == "P-256" && len(signature) == 64 {
			x, e1 := base64.RawURLEncoding.DecodeString(key.X)
			y, e2 := base64.RawURLEncoding.DecodeString(key.Y)
			if e1 != nil || e2 != nil || len(x) != 32 || len(y) != 32 {
				continue
			}
			pub := ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
			if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
				continue
			}
			valid = ecdsa.Verify(&pub, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
		}
		if valid {
			break
		}
	}
	if !valid {
		return result, invalidIdentity()
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return result, invalidIdentity()
	}
	defer wipe(payload)
	var claims struct {
		Issuer          string          `json:"iss"`
		Subject         string          `json:"sub"`
		Email           string          `json:"email"`
		Audience        json.RawMessage `json:"aud"`
		AuthorizedParty string          `json:"azp"`
		Expires         int64           `json:"exp"`
		IssuedAt        int64           `json:"iat"`
		NotBefore       int64           `json:"nbf"`
		Nonce           string          `json:"nonce"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Issuer != a.issuer || claims.Subject == "" || claims.Expires <= time.Now().Unix() || claims.IssuedAt > time.Now().Add(time.Minute).Unix() || claims.NotBefore > time.Now().Add(time.Minute).Unix() {
		return result, invalidIdentity()
	}
	var audiences []string
	var single string
	if json.Unmarshal(claims.Audience, &single) == nil {
		audiences = []string{single}
	} else if json.Unmarshal(claims.Audience, &audiences) != nil {
		return result, invalidIdentity()
	}
	matched := false
	for _, aud := range audiences {
		if aud == clientID {
			matched = true
		}
	}
	if !matched || (len(audiences) > 1 && claims.AuthorizedParty != clientID) || (claims.AuthorizedParty != "" && claims.AuthorizedParty != clientID) {
		return result, invalidIdentity()
	}
	if requireNonce && (nonce == "" || subtle.ConstantTimeCompare([]byte(claims.Nonce), []byte(nonce)) != 1) {
		return result, invalidIdentity()
	}
	return identity{claims.Subject, claims.Issuer, claims.Email}, nil
}
