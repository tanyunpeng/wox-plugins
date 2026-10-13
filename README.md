# Wox 插件：密码库 + 提示词

两个 Wox 插件：在 Wox 里查密码库并复制凭据，以及在 Wox 里管提示词模板并复制正文。

| 插件 | 触发词 | 文档 |
| --- | --- | --- |
| Bitwarden 密码库 | `pw` | [Wox.Plugin.bitwarden/README.md](Wox.Plugin.bitwarden/README.md) |
| 提示词 | `pt` | [Wox.Plugin.Script.Prompt/README.md](Wox.Plugin.Script.Prompt/README.md) |

## 安装

三端通用（Windows / Linux / macOS），需要 Node 22.5 以上，以及一次 Wox 重启。

```bash
git clone https://github.com/tanyunpeng/wox-plugins
cd wox-plugins
node install.mjs
```

`install.mjs` 做三件事：把提示词插件放进 Wox 的单文件插件目录 `~/.wox/wox-user/plugins/single-file/`
（Windows 上是 `%USERPROFILE%\.wox\...`，同一个地方）；装好密码库插件的依赖并打包；把
`Wox.Plugin.bitwarden` 登记成 Wox 的本地插件目录。跑完重启一次 Wox。若登记那一步报
`database is locked`，先退出 Wox 再跑一次。

Node 低于 22.5 时脚本会跳过登记这一步，前面照常装好；然后自己在 Wox 设置 → 插件 → wpm（Wox 插件管理器）
的「本地插件目录」里加上 `Wox.Plugin.bitwarden`，或者直接导入成品包 `wox.plugin.bitwarden.wox`。

**这个 clone 别删也别挪动**：密码库插件是从这个文件夹里直接加载的。提示词插件是复制过去的，删了这个文件夹
它也还在 Wox 里。

用法、配置项和隐私说明在上表各自的文档里。
