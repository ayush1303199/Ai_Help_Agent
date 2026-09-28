import type { MicrophoneDeviceOption } from '../../ai/interviewContext';

export function resolveMeetingMicrophoneInventory(
  audioInputCount: number,
  selectableDevices: MicrophoneDeviceOption[],
) {
  if (selectableDevices.length > 0) {
    return {
      devices: selectableDevices,
      unavailable: false,
      permissionRequired: false,
    };
  }
  if (audioInputCount > 0) {
    return {
      devices: [],
      unavailable: false,
      permissionRequired: true,
    };
  }
  return {
    devices: [],
    unavailable: true,
    permissionRequired: false,
  };
}
