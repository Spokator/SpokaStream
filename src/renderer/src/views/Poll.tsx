import { Check, Plus, Vote, X } from "lucide-react";
import { useState } from "react";
import { LIMITS } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { set, useApp } from "../state/store.ts";
import { plural } from "../ui/format.ts";
import { Button, IconButton, Modal } from "../ui/kit.tsx";

/** Toujours visible au-dessus du chat : on ne rate pas un vote parce que la conversation a défilé. */
export function PollCard() {
  const poll = useApp(s => s.room!.poll);
  const userId = useApp(s => s.userId);
  const isOwner = useApp(s => s.room!.ownerId === s.accountId);
  if (!poll) return null;
  const total = poll.options.reduce((n, o) => n + o.voters.length, 0);
  const best = Math.max(...poll.options.map(o => o.voters.length));
  const canManage = isOwner || poll.authorId === userId;
  return (
    <section className={`poll ${poll.closed ? "is-closed" : ""}`}>
      <header className="poll-head">
        <Vote size={14} />
        <span>{poll.closed ? "Sondage terminé" : `Sondage de ${poll.authorName}`}</span>
        {canManage && (
          <IconButton label="Retirer le sondage" onClick={() => core.dismissPoll(poll.id)}>
            <X size={14} />
          </IconButton>
        )}
      </header>
      <h3>{poll.question}</h3>
      <div className="poll-options">
        {poll.options.map((option, index) => {
          const votes = option.voters.length;
          const percent = total ? Math.round((votes / total) * 100) : 0;
          const mine = option.voters.includes(userId);
          return (
            <button key={option.text} type="button" disabled={poll.closed} className={`poll-option ${mine ? "is-mine" : ""} ${poll.closed && votes === best && votes > 0 ? "is-best" : ""}`} onClick={() => core.votePoll(poll.id, index)}>
              <i style={{ width: `${percent}%` }} />
              <span>
                {mine && <Check size={13} />}
                {option.text}
              </span>
              <b>{percent} %</b>
            </button>
          );
        })}
      </div>
      <footer className="poll-foot">
        <span>{plural(total, "vote")}</span>
        {canManage && !poll.closed && (
          <button type="button" className="link" onClick={() => core.closePoll(poll.id)}>
            Terminer
          </button>
        )}
      </footer>
    </section>
  );
}

export function PollModal() {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const close = () => set({ dialog: null });
  const filled = options.map(o => o.trim()).filter(Boolean);
  const canSend = !!question.trim() && new Set(filled).size >= 2;
  const submit = () => {
    if (!canSend) return;
    core.createPoll(question.trim(), filled);
    close();
  };

  return (
    <Modal
      title="Lancer un sondage"
      onClose={close}
      width={460}
      footer={
        <Button variant="primary" disabled={!canSend} onClick={submit}>
          Lancer le sondage
        </Button>
      }
    >
      <label className="stack">
        <span className="label">Question</span>
        <input className="input" autoFocus value={question} maxLength={LIMITS.pollQuestion} placeholder="On regarde quoi ce soir ?" onChange={e => setQuestion(e.target.value)} />
      </label>
      <div className="stack">
        <span className="label">Choix</span>
        {options.map((option, index) => (
          <div key={index} className="row-gap">
            <input
              className="input"
              value={option}
              maxLength={LIMITS.pollOption}
              placeholder={`Choix ${index + 1}`}
              aria-label={`Choix ${index + 1}`}
              onChange={e => setOptions(options.map((o, i) => (i === index ? e.target.value : o)))}
              onKeyDown={e => e.key === "Enter" && submit()}
            />
            {options.length > 2 && (
              <IconButton label="Retirer ce choix" onClick={() => setOptions(options.filter((_, i) => i !== index))}>
                <X size={15} />
              </IconButton>
            )}
          </div>
        ))}
        {options.length < LIMITS.pollOptions && (
          <Button variant="ghost" icon={<Plus size={15} />} onClick={() => setOptions([...options, ""])}>
            Ajouter un choix
          </Button>
        )}
      </div>
    </Modal>
  );
}
