declare module 'virtual:smoi-roster' {
  import type { CompanionInfo } from '@desktop/shared/companions';
  const roster: { defaultId: string; companions: CompanionInfo[] };
  export default roster;
}
