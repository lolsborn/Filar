import { useEffect, useState } from "react";
import { BookmarkCheck, BookmarkPlus, RotateCcw, Trash2 } from "lucide-react";
import type { LibraryState } from "../lib/library";

/**
 * Shows where the item being edited stands against the library, with the
 * one action that makes sense from there: save, update, revert or delete.
 */
export function LibraryBar(props: {
  state: LibraryState;
  /** e.g. "material" */
  noun: string;
  /** Name is blank, or otherwise cannot be saved. */
  invalid?: string | null;
  onSave: () => void;
  onRevert: () => void;
  onDelete: () => void;
}) {
  const { state, noun } = props;
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [state]);

  return (
    <div className="mt-3 flex min-h-[30px] items-center gap-2 rounded-[10px] bg-white/[0.035] py-1.5 pr-1.5 pl-2.5">
      {state === "builtin" && <span className="flex-1 text-[11px] text-ink-3">Built-in {noun}. Edit any value to make your own.</span>}
      {state === "builtinEdited" && (
        <>
          <span className="flex-1 text-[11px] leading-snug text-ink-2">Edited from a built-in. Give it a new name to save it.</span>
          <button className="btn !h-6 !px-2 text-[11px]" onClick={props.onRevert} title={`Go back to the built-in ${noun}`}>
            <RotateCcw size={12} /> Reset
          </button>
        </>
      )}
      {state === "saved" && (
        <>
          <span className="flex flex-1 items-center gap-1.5 text-[11px] text-ink-2">
            <BookmarkCheck size={13} className="text-accent" /> In your library
          </span>
          {confirming ? (
            <>
              <button className="btn !h-6 !px-2 text-[11px]" onClick={() => setConfirming(false)}>
                Keep
              </button>
              <button className="btn !h-6 !bg-critical/25 !px-2 text-[11px] !text-ink" onClick={props.onDelete}>
                Delete for good
              </button>
            </>
          ) : (
            <button className="icon-btn !h-6 !w-6 hover:!text-critical" title={`Delete this ${noun} from your library`} onClick={() => setConfirming(true)}>
              <Trash2 size={13} />
            </button>
          )}
        </>
      )}
      {state === "savedEdited" && (
        <>
          <span className="flex-1 text-[11px] text-ink-2">Changed since it was saved.</span>
          <button className="btn !h-6 !px-2 text-[11px]" onClick={props.onRevert} title="Go back to the saved values">
            <RotateCcw size={12} /> Revert
          </button>
          <button className="btn btn-primary !h-6 !px-2 text-[11px]" onClick={props.onSave}>
            Update
          </button>
        </>
      )}
      {state === "new" && (
        <>
          <span className="flex-1 text-[11px] leading-snug text-ink-2">{props.invalid ?? `Not in your library yet.`}</span>
          <button className="btn btn-primary !h-6 !px-2 text-[11px]" disabled={!!props.invalid} onClick={props.onSave} title={`Keep this ${noun} for use in other projects`}>
            <BookmarkPlus size={12} /> Save to library
          </button>
        </>
      )}
    </div>
  );
}
