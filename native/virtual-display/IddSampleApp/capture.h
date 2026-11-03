// capture.h — 3.2.2 取帧验证（App 侧 Desktop Duplication）
//
// 验证逻辑：SWD 创建前后各快照一次 DXGI 输出集合，差集即虚拟显示器输出；
// 对新输出做 Desktop Duplication 抓帧，统计帧数/间隔并落 BMP + CRC32，
// 证明「IddCx 虚拟显示器的画面能被应用层取到」——这正是阶段 4
// 计划采用的取帧架构（应用层 DD 抓帧 → 编码 → 发往平板）。
#pragma once
#include <windows.h>
#include <string>
#include <vector>

namespace iddpoc
{
/** 当前系统全部活动输出的 GDI 设备名（\\.\DISPLAYx），已排序 */
std::vector<std::wstring> SnapshotOutputs();

/**
 * 对 before 中不存在的新输出做 DD 抓帧验证。
 * 期间用 SendInput 轻微晃动鼠标强制桌面合成更新（静态桌面 DD 不出帧）。
 * 结果打印到控制台并追加 JSONL 到 outDir\capture-report.jsonl，
 * 每个输出落一张 BMP（首帧）。
 * @return 参与验证的新输出数量（0 = 没找到虚拟输出，视为失败）
 */
int CaptureNewOutputs(const std::vector<std::wstring>& before, int seconds, const std::wstring& outDir);
}
