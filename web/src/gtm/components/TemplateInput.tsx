import { useRef } from 'react';

/** Text input with clickable column chips that insert {{Column}} at the cursor. */
export function TemplateInput(props: { value: string; onChange: (v: string) => void; columns: string[]; multiline?: boolean; placeholder?: string; rows?: number }) {
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const node = el.current;
    const v = props.value ?? '';
    if (!node) return props.onChange(v + token);
    const start = node.selectionStart ?? v.length;
    const end = node.selectionEnd ?? v.length;
    props.onChange(v.slice(0, start) + token + v.slice(end));
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <div className="tpl">
      {props.multiline
        ? <textarea ref={el} value={props.value ?? ''} rows={props.rows ?? 5} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
        : <input ref={el} value={props.value ?? ''} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />}
      {props.columns.length > 0 && (
        <div className="chips">
          {props.columns.map((c) => <button type="button" key={c} className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(c)}>{c}</button>)}
        </div>
      )}
    </div>
  );
}
