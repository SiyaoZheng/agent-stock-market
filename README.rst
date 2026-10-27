Agent Stock Market Demo
======================

用 OpenAI Agents SDK 搭建的双股模拟交易室。八位不同背景的 Agent 共享微信群式聊天界面，
独立搜索信息、讨论行情，并通过工具下单。模型使用 DeepSeek Flash，关闭 thinking。

功能
----

* 两只虚构股票：青禾科技 QH、远山能源 YS。
* 中央订单簿按价格优先、时间优先撮合，支持限价单、市价单、部分成交和撤单。
* 实时成交价格走势图，可查看每笔成交的买卖双方、数量与价格变化。
* 所有参与者的现金、持仓、总资产、累计盈亏与收益率对比。
* 群聊支持 @、回复、投票、接龙、表情以及带来源的搜索结果分享。
* 人设、个人规则与私人记忆可实时编辑；观察界面显示简短状态摘要。
* SocialDataX 搜索覆盖微博、小红书、抖音、快手、B站、知乎、微信视频号、
  今日头条、百度贴吧、X、YouTube、Instagram 和 TikTok。

运行
----

需要 Python 3.11 或更新版本。在项目目录执行：

.. code-block:: sh

   python3 -m pip install --break-system-packages -r requirements.txt
   cp .env.example .env

在 .env 中填写 DEEPSEEK_API_KEY；使用社交媒体搜索时同时填写 SOCIALDATAX_API_KEY。
然后启动：

.. code-block:: sh

   python3 app.py

浏览器打开 http://127.0.0.1:8873/ ，点击开始运行。macOS 也可以双击 run.command。
页面提供暂停按钮，群聊没有总轮数上限。运行数据保存在本机 .runtime/ 中。

每位参与者初始拥有 100000 模拟现金、200 股 QH 和 400 股 YS，初始总资产 140000。
累计盈亏包含按最新成交价计算的持仓浮动盈亏。订单与资金均为本地模拟记录。
模型调用和 SocialDataX 查询使用各自服务的账户额度。

项目文件
--------

* app.py：API 服务、Agent 循环、实时角色状态与工具。
* market.py：整数金额记账及中央撮合器。
* social_search.py：SocialDataX 官方 MCP 搜索接口与结果整理。
* personas.json：八位虚构交易者的初始设定。
* static/：聊天、交易、图表、账户比较及信息检索界面。
* HOWTO.txt：撮合规则、控制台与本地存档的详细说明。

本机如已配置全局 llm DeepSeek 凭证或 Codex 中的 SocialDataX 授权，程序也可直接复用。
仓库中的 .env.example 仅包含配置项名称；各自的运行记录由本地实例保存。
