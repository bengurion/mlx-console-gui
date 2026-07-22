import { Field } from './Settings'
import { useSetting } from '../settings'

/**
 * One setting, edited where it is relevant.
 *
 * Configuration belongs next to the thing it configures — the models directory
 * beside the storage paths, LAN exposure beside the endpoint — rather than
 * behind a link to somewhere else. It is the same control the settings list
 * renders, writing through the same store, so the two can never disagree.
 */
export function InlineSetting({ short }: { short: string }) {
  const spec = useSetting(short)
  if (!spec) return null
  return <Field spec={spec} />
}
