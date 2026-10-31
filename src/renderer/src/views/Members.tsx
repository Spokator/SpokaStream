import { Ban, Crown, Headphones, HeadphoneOff, Mic, MicOff, MoreHorizontal, Radio, UserX } from "lucide-react";
import type { Member } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { Avatar, IconButton, Popover, Slider } from "../ui/kit.tsx";

function MemberRow({ member }: { member: Member }) {
  const userId = useApp(s => s.userId);
  const isOwner = useApp(s => s.room!.ownerId === s.userId);
  const speaking = useApp(s => !!s.speaking[member.id]);
  const live = useApp(s => s.room!.streams.some(x => x.ownerId === member.id));
  const volume = useApp(s => s.voiceVolumes[member.id] ?? 1);
  const isMe = member.id === userId;

  return (
    <div className={`member ${member.online ? "" : "is-offline"}`}>
      <Avatar name={member.name} color={member.color} src={member.avatar} size={34} ring={speaking} />
      <div className="member-text">
        <b>
          {member.name}
          {isMe && <small> (toi)</small>}
          {member.role === "owner" && <Crown size={12} className="member-crown" aria-label="Propriétaire" />}
        </b>
        <small>{!member.online ? "Reconnexion…" : live ? "En direct" : member.voice ? "En vocal" : "Dans le salon"}</small>
      </div>
      <div className="member-icons">
        {live && <Radio size={15} className="is-live" aria-label="En direct" />}
        {member.voice &&
          (member.voice.muted ? <MicOff size={15} className="is-off" aria-label="Micro coupé" /> : <Mic size={15} aria-label="Micro actif" />)}
        {member.voice &&
          (member.voice.deafened ? <HeadphoneOff size={15} className="is-off" aria-label="Sourdine" /> : <Headphones size={15} aria-label="Écoute" />)}
      </div>
      {isMe || !(member.voice || isOwner) ? (
        <span className="member-spacer" />
      ) : (
        <Popover
          align="right"
          trigger={(open, toggle) => (
            <IconButton label="Options" active={open} onClick={toggle}>
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        >
          {close => (
            <div className="menu">
              {member.voice && (
                <div className="menu-slider">
                  <span>Volume de sa voix : {Math.round(volume * 100)} %</span>
                  <Slider label="Volume de la voix" value={volume} min={0} max={3} step={0.05} onChange={v => core.setVoiceVolume(member.id, v)} />
                </div>
              )}
              {isOwner && (
                <>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      core.kickMember(member.id, false);
                      close();
                    }}
                  >
                    <span>
                      <UserX size={14} /> Exclure du salon
                    </span>
                  </button>
                  <button
                    type="button"
                    className="menu-item is-danger"
                    onClick={() => {
                      core.kickMember(member.id, true);
                      close();
                    }}
                  >
                    <span>
                      <Ban size={14} /> Bannir définitivement
                    </span>
                  </button>
                </>
              )}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

export function Members() {
  const members = useApp(s => s.room!.members);
  const sorted = [...members].sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.name.localeCompare(b.name, "fr"));
  return (
    <div className="members">
      {sorted.map(m => (
        <MemberRow key={m.id} member={m} />
      ))}
    </div>
  );
}
