import { createAddStampModal } from '../../components/AddStampModal.ts';

/** Keep the legacy stamp modal behind the .ts adapter boundary for now. */
export function openAddStampModal(onUploaded: () => void): void {
  createAddStampModal({ onUploaded });
}
