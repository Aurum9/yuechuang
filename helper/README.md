# 阅窗本地助手

Windows、Go 标准库实现，无外部运行时或依赖。当前版本 `0.1.0`。真实账号授权、套餐可用性及扩展直连 API 尚待人工验收，单元测试不代表官方账号连通成功。

## 构建和测试

在本目录运行（Go 1.26）：

```powershell
$env:GOCACHE = Join-Path (Get-Location) '.gocache'
go test -count=1 ./...
go vet ./...
go build -trimpath -ldflags='-s -w' -o bin/yuechuang-helper.exe .
```

测试 OAuth/JWKS/续期/撤销均使用本机 mock 服务，不会打开浏览器、不连接真实 OpenAI 账号。Windows 测试只对生成的虚构数据执行 DPAPI 操作，并在测试临时目录检查文件锁。测试不读取任何已安装应用的账号或凭证。

## 启动限制与数据

Chrome Native Messaging host 名为 `com.yuechuang.helper`。EXE 同目录必须包含 `helper-config.json`，内容只允许安装时确认的真实扩展 ID，例如：

```json
{"allowedOrigins":["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"]}
```

此示例 ID 不能直接用于安装。程序校验 Chrome 传入的首个参数是否与允许的完整 origin 相同；不接受请求中的 origin 覆盖。安装注册由同目录 PowerShell 脚本负责，运行助手本身不会写注册表。

专用存储路径为 `%LOCALAPPDATA%\YuechuangHelper\credentials.bin`，使用当前用户范围的 Windows DPAPI 加密整个文件。`credentials.lock` 通过 Windows 独占文件句柄串行化读、写及网络续期；操作系统在进程结束时释放锁。凭证文件以临时加密文件写入、同步后替换。目录不存储网页内容和聊天记录。

程序没有日志文件，标准输出仅用于 Native Messaging。账号信息、issued client ID、host ID、令牌与轮换信息都位于加密文件；普通状态响应不返回凭证。只有固定 `getAccessToken` 命令会返回 access token，refresh 和 ID token 不返回扩展。

## 协议

请求和响应使用 Chrome 标准 4 字节 little-endian 长度前缀、UTF-8 JSON；消息上限 1 MiB。请求：

```json
{"id":"unique-request-id","command":"status","accountId":"optional-existing-id","newAccount":false}
```

成功返回 `{ "id": "…", "ok": true, "result": … }`；失败返回 `{ "id": "…", "ok": false, "error": { "code": "…", "message": "可显示的中文说明" } }`。

| command | result |
| --- | --- |
| `status` | `{version,state,accounts,account?,loginPending}` |
| `login` | 完成授权后的 status；过程中保持 native port，最长 5 分钟 |
| `cancelLogin` | `{cancelled:true}`；必须通过正在登录的同一个 port 发送 |
| `getAccessToken` | `{accessToken,expiresAt,accountId}`；expiresAt 为 Unix 毫秒 |
| `logout` | status 加 `{remoteRevocationConfirmed:boolean}` |

`state` 为 `signedOut`、`ready`、`planDenied` 或 `reauthRequired`。每个 account 是 `{id,label,email?,planAuthorized}`；label 包含账号显示地址和注册 ID 的短标识，避免同邮箱的不同注册混淆。

`login` 默认重新授权指定 accountId 或当前账号；`newAccount:true` 才进行添加账号。不存在账号时走阅窗自己的动态注册。在交换失败时保留待完成的 issued client ID，下一次普通登录复用；只有身份校验通过才激活账号。

`login` 请求才会打开系统浏览器。监听器仅临时绑定 `127.0.0.1` 随机端口的 `/auth/callback`；完成、取消、超时或浏览器 native pipe 断开都会关闭。除登录回调之外，无 HTTP 监听和常驻服务。普通命令完成后，扩展应断开 port，让 Chrome 回收进程。

主要错误码：`loginInProgress`、`loginCancelled`、`loginTimeout`、`browserOpenFailed`、`callbackUnavailable`、`accessDenied`、`registrationIncomplete`、`clientMismatch`、`accountMismatch`、`identityValidationFailed`、`validationUnavailable`、`networkError`、`reauthRequired`、`planNotAuthorized`、`credentialUnavailable`、`tokenExchangeFailed`、`invalidTokenResponse`、`accountNotFound`。

## OAuth 行为

生产端点固定为 OpenAI 官方地址，不接受配置文件或扩展请求覆盖。首次以 `dynamic_agent_client`、实际名称「阅窗」和稳定的 `urn:uuid:` UUIDv4 host ID 发起授权；后续使用自己签发的客户端身份。每次生成新 state、nonce 和 S256 PKCE，校验原始回调 URI、issued client ID、签名/JWKS、issuer、audience、expiry、nonce 及返回账号身份。只使用 token 响应中的 scope 判断套餐授权；身份登录成功可以返回 `planDenied`，不能取得推理凭证。

续期使用保存的客户端身份，保留或替换最新 refresh token，并在整个过程持有跨进程锁。退出根据官方发现文档的撤销端点进行有限重试，再清除本地令牌；远程未确认时如实返回 false。账号与客户端映射及 host ID 保留供后续复用。此初版未传递可选 `id_token_hint`，重新授权可能显示账号选择页。

参考：[注册和登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账号和会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)。
