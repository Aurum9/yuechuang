# Sider Webapp 与当前官网协议差异复核

核查日期：2026-10-29。

## 证据范围

只读检查本机 Sider 5.35.3 发行目录中的 `background.js`、`content-chat.openai.com.js`、`options.js` 与 `manifest.json`。路径及文件指纹见[静态证据](验收证据/Sider-5.35.3-static/sources.json)。没有读取浏览器运行存储、Cookie、用户登录凭据或其它对话，也没有执行 Sider 程序或向模型发送消息。

当前官网对照来自此前经用户授权的一次正常官网发送，记录仅保留请求路径、字段名、模型名与响应状态，见[官网请求形态](验收证据/0.7.1/live-official-request-shapes-2026-10-29.json)。不同请求的观察顺序不能证明本轮严格的执行先后关系。

## Sider 的真实发送链路

1. `So()` 经 `ah()` 请求 `/api/auth/session`，短期缓存返回的会话凭证。
2. `G3e()` 经 `gi()` 请求 `/backend-api/sentinel/chat-requirements`；`$3e()` 在生成开始前取得这些要求。
3. `DS.generateAnswer()` 根据这些要求组装 Chat-Requirements、Proof 与条件性 Arkose 请求头。受查版本在本地实现部分校验处理，另有 offscreen 的 `getArkoseToken` 消息分支。本次没有复制、执行或重新实现这些校验算法。
4. 发送器经 `Zc()` 请求 `/backend-api/conversation`。文本与消息、模型、父消息、对话等字段放在 JSON 请求体中。
5. 返回内容可通过 HTTP SSE 传递；旧代码还识别 WebSocket 地址并解析其中包装的 SSE 消息。提取 assistant 文本、message ID 与 conversation ID 后推送扩展界面。
6. `ah()` 先在扩展后台直接 fetch。HTTP 403 会进入条件性 guard 流程，`Y3e()` 准备官网标签页，`j3e()` 经 `guard-proxy` Port 发送请求，页面脚本 `vc()` 再直接 fetch 并返回状态和响应流。这条路径没有填写官网编辑器。

上述代码支持“顺利直连时不创建官网标签页”。guard 路径仍可能创建固定且不激活的官网标签页，并复用它。不能承诺 Sider 在所有情况下都没有官网标签页。

## 关键兼容差异

| 项目 | Sider 5.35.3 静态实现 | 本机当前官网实测 |
| --- | --- | --- |
| 对话端点 | `/backend-api/conversation` | `/backend-api/f/conversation` |
| 发送前要求 | `/sentinel/chat-requirements` | 观察到 `/sentinel/chat-requirements/prepare` 和 `/finalize` |
| 条件性校验 | Arkose、Proof | 成功发送包含 Turnstile、Proof 请求头 |
| 对话准备 | 受查发送器没有新式准备步骤 | 观察到 `/conversation/init`、`/f/conversation/prepare` |
| 新请求字段 | 旧版消息与 history 参数 | 有 `client_prepare_state`、`supported_encodings` 等字段 |

四份白名单发行文件中没有发现 `chat-requirements/prepare`、`chat-requirements/finalize`、`/f/conversation` 或 Turnstile 字符串。后台中的 SDK 字符串属于其它库，未找到官方 Sentinel SDK URL。静态证据因此不能支持“存在一个已经查清、可直接复用的公开官方 SDK”或“照搬这版源码即可修复当前 403”的结论。

受查 manifest 对 ChatGPT 内容脚本的静态匹配仍为 `https://chat.openai.com/*`。本次没有运行验证其与当前 `chatgpt.com` 的匹配及重定向行为。

## 可复核位置

原始压缩后台脚本内，从 0 开始的 JavaScript 字符偏移：

| 标记 | 偏移 | 用途 |
| --- | ---: | --- |
| `G3e` | 866539 | 取得旧式 chat requirements |
| `$3e` | 868776 | 生成前读取要求 |
| `DS` | 868981 | Webapp 回答生成器 |
| 请求头组装 | 874081 | 合并认证、校验及设备字段 |
| conversation POST | 874162 | 旧式网页发送 |
| `CY` | 875439 | 显式打开固定 guard 标签页 |
| `z3e` | 876026 | 非激活状态新建固定标签页 |
| `Y3e` | 876393 | 准备 guard 标签页 |
| `So` | 877001 | 获取会话 |
| `j3e` | 877265 | Port 响应流代理 |
| `ah` | 878201 | 后台请求及 403 guard 分流 |
| `Zc` | 1068341 | SSE 包装及 transport 选择 |

## 对阅窗的实施含义

侧栏应继续自己承载输入与回答。网站登录或人工验证可以作为明确操作，官网聊天编辑器不适合作为用户已拒绝的日常发送通路。

可独立复用的部分包括固定域会话与模型请求、受限请求代理、响应流传回、消息归属及中止管理。发送前校验与新式响应格式必须先取得当前的合法可用接口并单独验证。代理只是请求执行位置的变化，不能弥补缺失的发送前要求，也不应把一条已被拒绝的生成请求无提示地重试。

若公开官方代码提供正常可调用的客户端接口，优先使用其完整受支持流程；遇到人工验证或访问拒绝应显示明确状态，不复制挑战算法、伪造校验结果或承诺已经打通。当前资料尚未确立该公开客户端接口。

## 当前官网公开静态代码复核

随后取得当前官网正常加载的 34 份公开 `/cdn/assets/*.js` 静态文件，入口 manifest 为 `manifest-99059f58.js`。原始公开 URL 清单在 `test-results/public-webapp-2026-10-29/inventory.json`；文件合计 20,086,029 字节。读取范围没有包含内联页面数据、页面运行时变量、账号接口响应或登录凭据，也没有执行源码或发起校验。

在 `7078.6cca9159bc.js` 中定位到 prepare/finalize 相关调用与内部打包模块 `lXEa`，模块从 JavaScript 字符偏移 626465 开始。其导出是 `a` 至 `f` 的压缩别名；实现直接包含网页要求的校验处理。这里仅确认职责和调用位置，没有提取或复现挑战处理算法。

在这批已加载文件中，没有找到 `sentinel.openai`、`tcr9i`、`SentinelSDK` 或 `sdk.js` 字符串；该内部模块没有指向独立 Sentinel SDK 的 URL 或脚本加载器。当前证据说明官网把相关客户端逻辑打包进了应用代码，尚不能确立一个可供第三方扩展正常集成的公开官方 SDK。内部压缩模块导出也没有公开兼容性约定，不能据此承诺可直接复用。

关键文件 SHA-256：

- `7078.6cca9159bc.js`：`edff1fc039af2a408c0be578173d1df447cb910f2d4e6d9d94e0189c7a9c4cf7`。
- `955979.2ec89565c4.js`：`a25fa89e0db8dfea154498e2f2a800530d421d578245438b520826d9a160ac1d`；包含接口允许列表中的 prepare 路径。

这项结论限定于本次公开静态样本；它不等同于证明任何版本、任何动态加载分支都没有其它接口。

## 官网内部模块的薄适配接口审计

继续只读检查模块外层签名及调用方，跳过挑战、Proof 与虚拟机的内部算法。以下均为当前构建的内部契约，尚未调用验证，也不属于公开 SDK。

`lXEa` 的导出映射如下：

| 导出 | 外层签名与职责 |
| --- | --- |
| `a` | 请求头名称常量表 |
| `b` | `(requirements, proofToken, turnstileToken) => headers`；优先使用 `requirements.token`，否则采用 `prepare_token` 对应的头 |
| `e` | `(value) => value`；仅验证响应为非空对象，否则抛错 |
| `f` | `async (prepareCallback) => integrityResult`；把当前 requirements key 传给回调，等待回调返回对象，再运行官网自身的正常要求处理 |

`f` 的返回对象外层字段为 `appAttestChallenge`、`chatRequirements`、`headers`、`proofToken`、`requirementsKey` 与 `turnstileToken`。认证和校验结果应只留在官网页面的适配闭包内，不能送往侧栏、日志、诊断或扩展持久存储。其它内部导出不需要由薄适配器单独调用。

调用方位于同一文件的内部模块 `r3oB`。普通浏览器准备函数 `V(signal, expectedAccountId?)` 把回调接到官网 `Kwur.Request.safePost('/sentinel/chat-requirements/prepare', options)`；请求体只有本轮 `p`，可选额外头 `X-OpenAI-Expected-Account-Id`，并传入中止信号。回调返回的是已解析 JSON 对象。

官网预取管理器的 `finalize` 方法只在条目仍属于相同账号、未中止且未过期、已有 `prepare_token` 而没有最终 `token`、并且未要求重新登录时调用 finalize。它将返回字段合并到当前 requirements 后重新组装请求头。匿名调用方则在需要时明确等待 finalize 结果。不能从这份代码推导“每次认证用户发送前必须同步 finalize”；也不能据此省略 requirements 检查。

`Kwur.Request` 重导出 `HFSu.b`。后者是带官网默认请求头和信号设置的请求对象，常见签名为：

- `safeGet(path, options?)`：返回解析后的 JSON body。
- `safePost(path, options?)`：接受 `requestBody`、`additionalHeaders`、`signal` 等，返回解析后的 JSON body。
- `postResponse(path, options?)`：接受同类选项，返回原始 `Response`，供有界流读取使用。

`HFSu` 位于 `767086.25089e447c.js`。其请求层会继续走官网现有传输，薄适配器无需将 Bearer 凭据传出页面。传输仍需要认证绑定、中止、非重复发送及有界解析；HTTP 拒绝或需要人工验证时应停止并展示明确状态。

可评估的路线是让同源页面中的薄适配器调用这些已加载的正常客户端接口，再把本轮文本流回传扩展。它仍依赖官网页面执行环境，不能承诺不使用任何后台页面资源。兼容性检查至少应确认模块、导出形状与返回结构；构建变化、模块缺失或未知响应应停止，不能擅自退回自行计算校验、重放凭据或操作官网编辑器。
