import type { BubbleBridge, DashboardBridge, PanelBridge } from '../shared/bridge';

declare global {
  interface Window {
    smoiBubble: BubbleBridge;
    smoiPanel: PanelBridge;
    smoiDashboard: DashboardBridge;
  }
}
export {};
