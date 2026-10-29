/** Slice ids become lookup keys in state and log lines, so they are restricted to safe characters. */
export const SLICE_ID_PATTERN = /^[a-z0-9-]+$/;

export type SliceStatus = 'pending' | 'in_review' | 'verifying' | 'approved' | 'stuck';

export interface PlannedSlice {
  id: string;
  title: string;
  description: string;
}

export interface Slice extends PlannedSlice {
  order: number;
  status: SliceStatus;
  reviewCycles: number;
  lastFeedback?: string;
  commit?: string;
}

export function sliceFromPlan(planned: PlannedSlice, order: number): Slice {
  return { ...planned, order, status: 'pending', reviewCycles: 0 };
}

export function isSliceFinished(slice: Slice) {
  return slice.status === 'approved' || slice.status === 'stuck';
}
