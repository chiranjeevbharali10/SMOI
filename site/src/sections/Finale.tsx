import { Sprite } from '../Sprite';
import { HOW_ITS_BUILT_URL } from '../links';
import { Scene } from '../motion';
import { smoi } from '../roster';
import { CallToAction } from './Hero';

export function Finale() {
  return (
    <>
      <Scene id="hello" tone="green" label="Get SMOI">
        <div className="finale">
          <Sprite companion={smoi} pose="celebrating" scale={4} label="SMOI celebrating" />
          <h2 className="finale-title">Say hi to SMOI.</h2>
          <p className="lede">Coming soon for Windows. Follow along while it learns new tricks.</p>
          <CallToAction />
        </div>
      </Scene>
      <footer className="footer">
        <div>Made by Chiranjeev.</div>
        <a href={HOW_ITS_BUILT_URL}>How it's built →</a>
        <small>
          Fonts: Pixelify Sans and Nunito, SIL Open Font License. The recorded answer quotes Wikipedia
          articles (CC BY-SA 4.0).
        </small>
      </footer>
    </>
  );
}
