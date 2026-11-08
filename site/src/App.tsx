import { Buddy } from './Buddy';
import { Ribbon } from './Ribbon';
import { AskScene } from './sections/AskScene';
import { FriendsScene, LinesScene, MoodsScene, PersonalityScene } from './sections/CharacterScenes';
import { DesktopScene } from './sections/DesktopScene';
import { Finale } from './sections/Finale';
import { Hero } from './sections/Hero';
import { InboxScene, PrivacyScene, RemembersScene } from './sections/LifeScenes';

/** The launch page: one idea per screen, in the order a newcomer would want to hear them. */
export function App() {
  return (
    <>
      <a className="skip" href="#desktop">Skip to the tour</a>
      <main>
        <Hero />
        <Ribbon tone="green" />
        <DesktopScene />
        <AskScene />
        <RemembersScene />
        <InboxScene />
        <PrivacyScene />
        <MoodsScene />
        <FriendsScene />
        <PersonalityScene />
        <LinesScene />
        <Ribbon tone="pink" reverse offset={6} />
        <Finale />
      </main>
      <Buddy />
    </>
  );
}
