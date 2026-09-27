/**
 * 版本号（design/engine.md §13）：
 * - ENGINE_VERSION 用 semver：规则或数据变化时升次版本号（同时刷新 golden，见 architecture §11 末尾的回写路径）。
 * - STATE_SCHEMA_VERSION：state 结构变化时加 1，并在 migrate/ 补一个迁移函数。
 */
/**
 * 0.2.0：M4 经济系统（银行、股市、乐透、百货、设施与企业收费、月结）
 * 0.3.0：M6 对抗系统（30 张卡、13 种道具与路面物件、13 种神明、关押与保释、乞丐；开局摆放神明与礼物宝箱，随机序列变化）
 * 0.4.0：M7 事件与收尾规则（新闻 36、命运 37、魔法屋、四大恶人与雇用、并发拍卖与清算拍卖、投降与死神、时光机、
 *        公布栏；TABLES 增加 news / fate / magic，tablesHash 变化；新帧状态字段 CONFINE.wreck、RandPurpose 'auction'）
 */
export const ENGINE_VERSION = '0.4.0';
export const STATE_SCHEMA_VERSION = 1;
