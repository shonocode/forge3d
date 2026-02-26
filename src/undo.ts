import { status } from "./state";

export interface UndoCommand {
  label: string;
  undo(): void;
  redo(): void;
}

export class UndoHistory {
  private undoStack: UndoCommand[] = [];
  private redoStack: UndoCommand[] = [];
  private readonly maxSize = 50;

  push(cmd: UndoCommand): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    status("Undo: " + cmd.label);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this.undoStack.push(cmd);
    status("Redo: " + cmd.label);
    return true;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
