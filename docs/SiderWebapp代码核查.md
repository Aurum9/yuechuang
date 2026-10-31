# Sider ChatGPT Webapp 代码核查

日期：2026-10-28。受查版本：本机安装的 Sider 5.35.3。

本轮已读取 Sider 自己的静态安装文件，确认其浏览器会话接入实现。研究范围限定于该扩展版本目录内的程序文件；没有读取 Chrome 账号配置、Cookie 数据库、扩展运行存储或真实登录凭证，没有执行 Sider 代码或发起账号／模型调用。

## 已确认的实现

1. **入口保留在设置界面。**`options.js` 中服务提供商下拉框包含 `siderApi`、`gpt3`、`chatgpt` 三个值；`chatgpt` 的显示名称为 ChatGPT Webapp。选择后保存 provider，并渲染 Webapp 的设置内容。
2. **取得当前网页会话凭证。**`background.js` 定义 ChatGPT 会话地址 `/api/auth/session`。`So()` 通过 `ah()` 请求会话，读取响应的 `accessToken` 并放入短期内存缓存。
3. **调用网页端接口。**后台的 provider 分流在值为 `chatgpt` 时调用 `So()`，随后构造 `DS` Webapp 回答生成器。生成器以 Bearer 凭证请求 `https://chatgpt.com/backend-api/conversation`，传入文本、模型、当前对话 ID 与上一条消息 ID 等字段。模型列表也走网页端 `/backend-api/models`。
4. **流式显示到自己的界面。**后台支持 SSE 和 WebSocket 两种响应，解析消息内容、消息 ID 和对话 ID，通过事件与扩展 Port 回传给侧栏。此请求链路可以直接收发模型消息。
5. **必要时让 ChatGPT 标签页代发。**`ah()` 先尝试直接请求，遇到 403 时会进入 guarded-tab 流程，创建／复用／刷新固定的 ChatGPT 标签页；`j3e()` 连接名为 `guard-proxy` 的 Port。网页脚本的 `vc()` 收到请求后执行 `fetch`，把响应状态与文本流分块传回后台。后台重建 Response 和 ReadableStream，继续使用原有解析流程。
6. **另外保留了页面自动填写功能。**网页脚本的 `Lt()` 会找输入框和发送按钮，填入提示词并发送。这是另一条自动化路径；不能把它和 Webapp 回答生成器的直接请求链路混为一谈。

上述核心链路全部位于 Chrome 扩展后台及网页脚本中，程序结构没有要求额外本机助手参与这条 Webapp 请求。

## 当前入口与运行边界

在 5.35.3 静态代码中同时找到了设置选项、provider 分流、会话请求、对话请求和流式返回，证据强于仅出现一个旧接口字符串。**本轮仍未用真实账号验证它今天能否成功返回回答。**

代码还处理网页要求的额外请求校验。这说明接入工作包含持续适配网页协议，不能仅实现“取到 accessToken”便宣称完成。Sider 官方也在[故障说明](https://sider.ai/help-center/faqs/sider-error)中承认，OpenAI 参数变更可能导致 Webapp 失效。

该版本的 Webapp 请求中 `history_and_training_disabled` 固定为 false；本轮未验证其账号数据行为，不能据此承诺零云端保存，也不能把界面关闭当作对话已从服务端删除。

## 可核对的位置

以下为原始压缩文件中的字符偏移，从 0 开始。完整文件路径、文件大小、SHA-256 与关键标记见 [静态证据](验收证据/Sider-5.35.3-static/sources.json)。

| 文件 | 位置 | 作用 |
| --- | --- | --- |
| background.js | 799337 | 会话端点常量 |
| background.js | 877001 | So：取得会话 accessToken |
| background.js | 874162 | Webapp 对话 POST |
| background.js | 878201 | ah：直接请求和标签页代理回退 |
| background.js | 877265 | j3e：guard-proxy Port 桥接 |
| background.js | 2430982 | chatgpt provider 实例化 DS |
| content-chat.openai.com.js | 115816 | vc：网页内 fetch 和响应流回传 |
| content-chat.openai.com.js | 36651 | Lt：独立的页面填写及发送逻辑 |
| options.js | 1757800 附近 | 三种 provider 的设置下拉框 |

后台文件 SHA-256：`3e0f73c2a85ba1705123f783bc8952a84a56e61f6140172440116f0065ac7757`。

## 2026-10-29 补充复核：标签页的实际用途

再次只读核查上述四个白名单程序文件，四份 SHA-256 均与静态证据一致。未读取用户配置、Cookie 数据、运行存储或凭证，未执行发行代码。这次针对“为何 Sider 使用时可能看不到额外的 ChatGPT 标签页”逐项复核。

**这份发行代码采用后台直接请求，403 时才考虑官网标签页代理。**`DS.generateAnswer()` 的 SSE 工具 `Zc()` 以第三个参数 true 选择 `ah()`；`ah()` 内首先调用后台 `fetch`。正常返回时直接交回上层，无需为本次请求创建 ChatGPT 标签页。网络错误或 401 也不会在这段代码中转入标签页代理。

遇到 403 后，`ah()` 设置短期状态，并调用 `Y3e()` 准备标签页，再由 `j3e()` 使用 `guard-proxy` Port 代发。存在一个重要条件：当调用指定 `throwGuideError` 且尚无 guard 状态时，会先返回引导错误；provider 初次取得会话的 `So()` 调用设置了这个选项。因此“任何 403 都会立即自动新建标签页”超出了代码证据。

| 路径 | 静态代码中的标签页行为 | 位置，JavaScript 字符偏移 |
| --- | --- | --- |
| 普通会话／模型／对话请求 | 先在后台直接 `fetch`，成功无需新建官网标签页 | `background.js`：`ah` 878201；`Zc` 1068347 |
| 用户显式打开 guard 页 | `CY()` 先按已记标签页 ID 取得并激活；不存在时新建固定标签页，`pinned:true, active:true` | `background.js`：875439；消息入口 2439154 |
| 403 的 guard 准备 | `Y3e()` 先复用已记 ID；旧域页面执行 reload，其它页面导航到官网；失败后寻找已固定的 `https://chatgpt.com/*` 标签页并 reload；仍没有则新建 | `background.js`：`Y3e` 876393；`J3e` 876207 |
| 自动新建 guard 页 | `z3e()` 使用 `pinned:true, active:false`，保存标签页 ID | `background.js`：876026 |
| 代理一次请求 | 页面脚本直接 `fetch` 请求地址，传回响应状态与文本流；没有填写聊天输入框或点击发送按钮 | `background.js`：`j3e` 877265；`content-chat.openai.com.js`：`vc` 115816 |
| 完成或取消代理 | 关闭／断开 Port 与流；取消时中止页面 fetch。这段链路未调用 `tabs.remove` 关闭 guard 标签页 | `j3e` 与 `vc` 同上 |

追踪后台保存 guard 标签页的变量 `qu`，共九处引用，覆盖恢复 ID、读取、激活、更新、保存与代理发送，未出现按该 ID 关闭标签页的路径。后台其它功能确实有 `tabs.remove`，包括 OAuth、浏览器任务及网页读取；这些调用不能作为 guard 会话每轮清理的证据。**可确认顺利直连时无需额外官网标签页；进入 guard 路径后则会复用固定标签页。这份代码不支持“Sider 始终没有常驻官网标签页”的结论。**用户使用时未注意到标签页，也不足以确认当次走了哪条路径。

### offscreen、iframe 与额外校验

发行包声明了 `offscreen` 权限，后台也有 `offscreen.createDocument`；因此不能笼统说 Sider 没有隐藏文档。在 Webapp 生成器中，还能定位到条件满足时发送 `getArkoseToken` 消息给 `target:"offscreen"` 的调用。这里仅记录调用位置和职责，不复现校验算法，也未执行相关请求。

已核查的会话传输链路是“后台 fetch → 必要时官网标签页中的 fetch”。`Y3e/j3e/vc` 没有创建 iframe 或 offscreen 文档来替代 guard 标签页。后台全局 offscreen 创建函数还用于录屏、资源和浏览器任务，不能把它的存在直接解释为 Webapp 对话通过隐藏 iframe 收发。

额外校验的可见调用点包括：`G3e()` 请求网页的 chat requirements，`$3e()` 在生成前取得要求，`DS.generateAnswer()` 按要求组装相关请求头；部分条件分支会调用上面的 offscreen 消息。这个实现已经明显超过“拿到会话 token 后直接 POST”。这些位置仅能说明 5.35.3 曾实现相应协议适配，无法证明它兼容今天的服务端要求。

还有一项兼容性限制：受查 `manifest.json` 中，`content-chat.openai.com.js` 的静态匹配只有 `https://chat.openai.com/*`；在本轮白名单后台文件中未找到对该文件的动态注册。官网域名重定向、其它发行构建或运行时行为是否补足这部分，本轮没有验证。故不能凭静态调用链宣称今天的 guard 代理已经可用。

### 与阅窗当前页面发送方案的区别

阅窗新增的官网页面方案让官方编辑器完成正常发送，再读取本轮回答；它需要一个专用官网标签页承载模型选择、生成和后续对话。Sider 上述 Webapp 主路径直接调用网页接口，guard 代理也只负责把 fetch 放到官网页面执行。两者在发送动作和协议适配责任上有实质区别。

据此，可以说 Sider 的直接请求路径在顺利工作时占用的页面资源更少。仍不能从静态代码断言它当前成功率、速度或后台标签页数量，也不能承诺将其旧协议照搬便能解决阅窗实际遇到的 403。当前官网实测请求形态另见[连接状态与诊断修订](M6连接状态与诊断修订.md)。

## 对我们插件的意义

可以优先验证纯浏览器的 Webapp 适配器：只授权 ChatGPT 域，在本人已登录的网页中取得会话，只把结果及登录状态返回侧栏；保留 API Key 模式。先验收一轮明确发送、流式返回和停止，再考虑阅读功能接入。真实网页校验失败应停止并提示，不自动切换计费或绕过用户交互。

官方套餐 OAuth 加本机助手仍是另一种可选架构。此前将其需求扩大到所有插件登录方案、或将网页模式限定为必须模拟点击，均需以上述静态实证修正。

作为公开可读的对照项目，ChatGPTBox 也包含[会话获取](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/src/services/wrappers.mjs#L22)、[网页对话与流式解析](https://github.com/ChatGPTBox-dev/chatGPTBox/blob/745fdf5fedcd440b2331cb85fbdefd5b0a0ed336/src/services/apis/chatgpt-web.mjs#L268)。这些公开源码是参考实现，Sider 的结论来自本轮其自身程序文件。
