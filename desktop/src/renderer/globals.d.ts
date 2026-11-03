import type { BubbleBridge, DashboardBridge, PanelBridge, RecorderBridge } from '../shared/bridge';

declare global {
  interface Window {
    smoiBubble: BubbleBridge;
    smoiPanel: PanelBridge;
    smoiRecorder: RecorderBridge;
    smoiDashboard: DashboardBridge;
  }
}
export {};
