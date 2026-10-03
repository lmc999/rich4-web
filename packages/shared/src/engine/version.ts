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
 * 0.5.0：用户反馈修复两项按原版改规则（architecture §28.2、§29）：
 *        百货道具一次买一个、每次进店每种只能买一次、真人货架只列进店时有库存的（V-R30；电脑本来如此，golden 不变）；
 *        监狱 / 医院获释不再搬到保释格：留在关押格、来路 = 关押格，下一回合在全部未封邻格里随机选方向（V-M7，
 *        exe v2.06 0x40d184 / 0x40bc10；台湾两条只能从关押格走出的支线因此可达，四张图 golden 刷新）。
 *        PlayerState.savedPrevNode 不再写入（恒为 null，字段保留），state 结构不变
 */
export const ENGINE_VERSION = '0.5.0';
export const STATE_SCHEMA_VERSION = 1;
