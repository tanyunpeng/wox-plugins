# Wox 插件：密码库 + 提示词 + 待办

三个 Wox 插件：在 Wox 里查密码库并复制凭据，在 Wox 里管提示词模板并复制正文，以及在 Wox 里记待办。

| 插件 | 触发词 | 文档 |
| --- | --- | --- |
| Bitwarden 密码库 | `pw` | [Wox.Plugin.bitwarden/README.md](Wox.Plugin.bitwarden/README.md) |
| 提示词 | `pt` | [Wox.Plugin.Script.Prompt/README.md](Wox.Plugin.Script.Prompt/README.md) |
| 待办 | `td` | [Wox.Plugin.Todo/README.md](Wox.Plugin.Todo/README.md) |

## 安装

三端通用（Windows / Linux / macOS），需要 Node 22.5 以上，以及一次 Wox 重启。

```bash
git clone https://github.com/tanyunpeng/wox-plugins
cd wox-plugins
node install.mjs
```

`install.mjs` 做三件事：把提示词插件放进 Wox 的单文件插件目录 `~/.wox/wox-user/plugins/single-file/`
（Windows 上是 `%USERPROFILE%\.wox\...`，同一个地方）；装好密码库插件的依赖并打包；把
`Wox.Plugin.bitwarden` 和 `Wox.Plugin.Todo` 都登记成 Wox 的本地插件目录（待办插件没有依赖，从仓库目录直接加载）。
跑完重启一次 Wox。若登记那一步报 `database is locked`，先退出 Wox 再跑一次。

Node 低于 22.5 时脚本会跳过登记这一步，前面照常装好；然后自己在 Wox 设置 → 插件 → wpm（Wox 插件管理器）
的「本地插件目录」里加上上面那两个文件夹，或者直接导入各自的成品包（`*.wox`）。

**这个 clone 别删也别挪动**：密码库和待办插件是从这个文件夹里直接加载的。提示词插件是复制过去的，删了这个文件夹
它也还在 Wox 里。

用法、配置项和隐私说明在上表各自的文档里。

## 许可证

GPL-3.0，与 [Wox 本体](https://github.com/Wox-launcher/Wox) 一致，全文见 [LICENSE](LICENSE)。

插件通过 Wox 的公开插件接口在独立进程里运行，是否构成 GPL 意义上的衍生作品本身存在争议；这里采用同一份许可证
是主动选择，不是被要求的结果。也就是说：这三个插件的源码以 GPL-3.0 分发，拿到成品包的人有权索取源码。
