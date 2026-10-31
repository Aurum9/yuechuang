# 第三方组件

阅窗自身代码采用根目录 `LICENSE` 中的 MIT 许可。以下第三方组件保留各自的版权与许可条款。

发布包的正文提取包含 Mozilla Readability（Apache License 2.0）。版权声明见发布包 `READABILITY-LICENSE.md`，完整许可见 `LICENSE-APACHE-2.0.txt`，源地址：https://github.com/mozilla/readability 。

侧栏聊天的 Markdown 解析包含 Marked（MIT License），见 `MARKED-LICENSE.txt`，源地址：https://github.com/markedjs/marked 。渲染结果使用 DOMPurify 过滤（Apache License 2.0 / Mozilla Public License 2.0 双重许可），见 `DOMPURIFY-LICENSE.txt` 与 `DOMPURIFY-LICENSE-MPL.txt`，源地址：https://github.com/cure53/DOMPurify 。两者随扩展在本机运行，不加载远程脚本。

开发构建使用 TypeScript、Vite、Playwright、tsx 和 fflate；精确版本记录在 package-lock.json，各自许可保留于 node_modules 包中。运行扩展无需加载远程可执行代码。
