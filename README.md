# wox-plugins

三个 Wox 启动器插件：查密码库、管提示词模板、记待办。

| 插件 | 触发词 | 文档 |
| --- | --- | --- |
| Bitwarden 密码库 | `pw` | [Wox.Plugin.bitwarden/README.md](Wox.Plugin.bitwarden/README.md) |
| 提示词 | `pt` | [Wox.Plugin.Script.Prompt/README.md](Wox.Plugin.Script.Prompt/README.md) |
| 待办 | `td` / `todo` | [Wox.Plugin.Todo/README.md](Wox.Plugin.Todo/README.md) |

用法、配置项和隐私说明在各自的文档里。

## 安装

Windows / Linux / macOS。需要 Node 22.5 以上（只为了替你登记本地插件目录那一步，低版本见下），装完重启一次 Wox。

```bash
git clone https://github.com/tanyunpeng/wox-plugins
cd wox-plugins
node install.mjs
```

`pw` 和 `td` 是从这个 clone 里直接加载的，**clone 别删也别挪**；`pt` 是复制进 Wox 的，删了它还在。

登记那一步报 `database is locked`：退出 Wox，再跑一次 `node install.mjs`。

Node 低于 22.5 时脚本会跳过登记，`pt` 和 `pw` 照常装好。`td` 要你自己补一下：Wox 设置 → 插件 → wpm（Wox 插件管理器）
的「本地插件目录」里加上 `Wox.Plugin.bitwarden` 和 `Wox.Plugin.Todo`。

## 许可证

GPL-3.0，与 [Wox 本体](https://github.com/Wox-launcher/Wox) 一致，全文见 [LICENSE](LICENSE)。

插件通过 Wox 的公开接口在独立进程里运行，这是否构成 GPL 意义上的衍生作品本身有争议；采用同一份许可证是主动选择。
