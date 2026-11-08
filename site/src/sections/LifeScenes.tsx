import { useState } from 'react';
import type { FrogState } from '@desktop/shared/animations';
import { poseName } from '@desktop/shared/companions';
import { DEFAULT_PERSONALITY, react } from '@desktop/shared/personality';
import { CenteredBubble } from '../CenteredBubble';
import { Sprite } from '../Sprite';
import { Scene, useInView, useTimeout } from '../motion';
import { smoi } from '../roster';

/* Everything on this page's inbox and task cards is made up for the demo. */

const TASKS = [
  { title: 'Finish the lab report', note: 'Due Friday · high priority' },
  { title: 'Buy oat milk', note: 'Errands' },
  { title: 'Stretch', note: 'Every weekday at 18:00' },
];

export function RemembersScene() {
  const [done, setDone] = useState<Set<number>>(new Set());
  const [ref, seen] = useInView<HTMLDivElement>(0.4);
  const reminder = react({ type: 'reminder', title: 'Call mum', missed: false }, DEFAULT_PERSONALITY);
  const [cheer, setCheer] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const toggle = (i: number) => {
    setDone((d) => {
      const n = new Set(d);
      if (n.has(i)) n.delete(i);
      else {
        n.add(i);
        setCheer((c) => c + 1);
      }
      return n;
    });
  };
  useTimeout(() => setCheer(0), cheer > 0 ? 2400 : null, [cheer]);
  const pose = cheer > 0 ? 'celebrating' : poseName(smoi, reminder.frog as FrogState);

  return (
    <Scene id="remembers" tone="pink" label="Tasks and reminders">
      <p className="kicker">Tasks and reminders</p>
      <h2>It <mark className="hl hl-blue">remembers</mark> so you don't have to.</h2>
      <p className="lede">
        Tell SMOI what you need to do, by typing or out loud. It keeps the list, and when it's time,
        it taps you on the shoulder. Gently. Mostly.
      </p>
      <div className="split" ref={ref}>
        <div className="frog-with-bubble">
          {seen && reminder.line && !dismissed && <CenteredBubble line={reminder.line} onDismiss={() => setDismissed(true)} />}
          <Sprite key={cheer} companion={smoi} pose={pose} scale={3}
            label={cheer > 0 ? 'SMOI celebrating' : 'SMOI reminding you to call your mum'} />
        </div>
        <div className="card list">
          <div className="list-title">Today</div>
          {TASKS.map((t, i) => (
            <label key={t.title} className={`task${done.has(i) ? ' done' : ''}`}>
              <input type="checkbox" checked={done.has(i)} onChange={() => toggle(i)} />
              <span><strong>{t.title}</strong><small>{t.note}</small></span>
            </label>
          ))}
          <p className="list-hint">Go on, tick one off.</p>
        </div>
      </div>
    </Scene>
  );
}

const MAIL = [
  { category: 'important', from: 'Campus Housing', summary: 'The sender asks you to renew your room contract before Friday, or the room is released.' },
  { category: 'recruitment', from: 'Talent team, a studio', summary: 'The sender invites you to a 30-minute call next week and asks for two time slots.' },
  { category: 'promotional', from: 'A bookshop', summary: 'A newsletter about a weekend sale. Nothing to do.' },
];

export function InboxScene() {
  const [ref, seen] = useInView<HTMLDivElement>(0.4);
  return (
    <Scene id="inbox" tone="blue" label="Inbox">
      <p className="kicker">Gmail and Google Calendar</p>
      <h2>Your inbox, sorted. <mark className="hl hl-pink">Never sent.</mark></h2>
      <p className="lede">
        SMOI reads your unread mail, sorts it, and tells you in one line what each email wants. It can
        write a reply for you, but it only ever saves a draft. You press send.
      </p>
      <div className={`inbox${seen ? ' in' : ''}`} ref={ref}>
        {MAIL.map((m, i) => (
          <article key={m.from} className="card mail" style={{ animationDelay: `${i * 140}ms` }}>
            <span className={`tag tag-${m.category}`}>{m.category}</span>
            <strong>{m.from}</strong>
            <p>{m.summary}</p>
          </article>
        ))}
        <article className="card mail draft" style={{ animationDelay: '520ms' }}>
          <span className="tag tag-draft">draft</span>
          <strong>Re: Room contract</strong>
          <p>Hi, I'd like to renew for next year. Could you send the form? Thanks!</p>
          <div className="draft-note">SMOI writes drafts. You press send.</div>
        </article>
      </div>
      <p className="demo-caption">Sample emails. Changes to your calendar are shown to you first and only happen when you say yes.</p>
    </Scene>
  );
}

export function PrivacyScene() {
  return (
    <Scene id="private" tone="lavender" label="Privacy">
      <div className="privacy">
        <Sprite companion={smoi} pose="sleeping" scale={3} label="SMOI asleep" />
        <div>
          <p className="kicker">Private by default</p>
          <h2>Your files <mark className="hl hl-green">never leave</mark> your computer.</h2>
          <ul className="points">
            <li><strong>Local AI by default.</strong> Answers come from a model running on your own machine.</li>
            <li><strong>You choose, file by file.</strong> Nothing goes to a cloud AI unless you switch it on for that document.</li>
            <li><strong>It minds its own business.</strong> SMOI never looks at your other windows or apps.</li>
          </ul>
        </div>
      </div>
    </Scene>
  );
}
