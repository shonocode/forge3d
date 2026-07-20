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
  private onChange: (() => void) | null = null;
  private _version = 0;

  /**
   * Monotonic edit counter: bumps on every history mutation (push / undo /
   * redo / popUndo / clear). Consumers that checkpoint the scene (autosave)
   * compare it to skip work when nothing changed since their last run.
   */
  get version(): number { return this._version; }

  setOnChange(cb: () => void): void { this.onChange = cb; }

  push(cmd: UndoCommand): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this._version++;
    this.onChange?.();
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    try {
      cmd.undo();
    } catch (e) {
      console.warn("Undo failed:", cmd.label, e);
    }
    this.redoStack.push(cmd);
    status("Undo: " + cmd.label);
    this._version++;
    this.onChange?.();
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    try {
      cmd.redo();
    } catch (e) {
      console.warn("Redo failed:", cmd.label, e);
    }
    this.undoStack.push(cmd);
    status("Redo: " + cmd.label);
    this._version++;
    this.onChange?.();
    return true;
  }

  /** Remove and return the last undo entry without executing it. Used for compound undo grouping. */
  popUndo(): UndoCommand | undefined {
    const cmd = this.undoStack.pop();
    if (cmd) this._version++;
    this.onChange?.();
    return cmd;
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  undoCount(): number { return this.undoStack.length; }
  redoCount(): number { return this.redoStack.length; }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._version++;
    this.onChange?.();
  }
}
