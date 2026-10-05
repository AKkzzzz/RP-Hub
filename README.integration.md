# 我们的 RP-Hub 接入

前端：https://akkzzzz.github.io/RP-Hub/

自建广场：https://api.20-89-42-182.sslip.io/forum/

管理后台：https://api.20-89-42-182.sslip.io/forum/admin

云同步：https://api.20-89-42-182.sslip.io/rphub-sync

GitHub Pages 只发布静态前端。Azure 保存广场数据库、云同步和现有 API 服务。
万相广场入口仅连接我们的 RPH-Forum；原站内容与账户不会迁入。
广场账号与云同步账号目前独立，后续可统一账户。
浏览器数据库按站点隔离；原 Azure 前端的数据可通过现有云同步账号同步，或导出后导入新站。

公开的 site-config.js 只包含服务地址，所有账户密钥保持私有。
请在 RP-Hub 设置里配置自己的 API 地址、Key 和模型。现有 Azure API 地址为
https://api.20-89-42-182.sslip.io/v1 。

本项目基于 STA1N156/RP-Hub，保留原许可和署名，增加了自建广场与 Azure 同步接入。
RP-Hub 使用 CC BY-NC 4.0；如计划提供收费、广告等商业功能，应先取得原作者授权，或在上线前替换相关实现。

main 分支提交自动部署到 GitHub Pages。升级上游时，合并上游代码后保留接入改动；前端适配脚本在本地 connection-kit 中。
