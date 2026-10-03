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
 *        PlayerState.savedPrevNode 不再写入（恒为 null，字段保留），state 结构不变。
 *        同版本另含电脑放置类道具选格按原版（architecture §31，只改 AI、引擎规则不变）：路障阶段二、地雷、定时炸弹的后瞻
 *        从往回第 2 格起（exe v3.11 0x40b343，来路格本身不算），候选按屏幕行序逐个与后瞻比对；四张图 golden 再次刷新
 * 0.6.0：座驾按原版（architecture §34）：
 *        梦游卡停放原座驾、梦游结束时装回——机车 / 汽车背包里还有才装回（背包 −1、骰子数恢复），工程车连同剩余天数直接装回、
 *        梦游期间不倒数、醒来那一回合照常算一天（exe v2.06 0x442fa8 / 0x41c1aa / 0x41c4a6）；冬眠卡取消梦游时不装回；
 *        开着工程车时机车 / 汽车道具照样能用，直接顶掉工程车、不退还（0x4459e9 / 0x445aa4 只比较 ==1 / ==2）。
 *        PlayerState 新增 parked（梦游卡停放的座驾），STATE_SCHEMA_VERSION 不变，旧快照由 migrateState 补 null；
 *        VEHICLE 新增 via / from（梦游、醒来、工程车到期、魔法屋卖光：原版只刷新外观），VEHICLE_DESTROYED 新增 via 'fate'
 *        （命运 10 / 11 失车）。电脑策略不变（v3.11 0x421644 / 0x421675 在工程车模式下不用机车 / 汽车）；四张图 golden 刷新。
 *        同版本补两条（尚未发布）：魔法屋 / 命运 32「卖光道具」时开着工程车，按原版折成 12 号道具一起卖（得 12 号的点券价，
 *        exe 0x4446de / 0x444728）；工程车到期换回原车时骰子数恢复成开工程车之前的（+0x65，0x41c529），EngineerState 新增 dice，
 *        旧快照由 migrateState 补成换回座驾的上限。golden 再刷新一次
 */
export const ENGINE_VERSION = '0.6.0';
export const STATE_SCHEMA_VERSION = 1;
