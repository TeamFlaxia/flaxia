export interface StudioFileHistoryState {
  files: readonly File[];
  activeIndex: number;
}

/** Compare immutable project files by identity and serializable edits by value. */
export function sameStudioFileHistoryState<T extends StudioFileHistoryState>(left: T, right: T): boolean {
  const { files: leftFiles, ...leftEdits } = left;
  const { files: rightFiles, ...rightEdits } = right;
  return (
    JSON.stringify(leftEdits) === JSON.stringify(rightEdits) &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) => file === rightFiles[index])
  );
}
