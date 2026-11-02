/**
 * A small SMOI face from the design's expression sheet, used as a status icon next to text. It
 * is decorative (alt=""): the text beside it always says the same thing in words.
 */
export type FaceName = 'shocked' | 'focused' | 'pondering' | 'joyful' | 'confused' | 'neutral' | 'chatty';

export function Face({ name }: { name: FaceName }) {
  return <img className="face" src={`./expressions/${name}.png`} width={48} height={40} alt="" />;
}
