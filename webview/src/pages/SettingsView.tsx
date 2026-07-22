import { SettingsPage } from './Settings'
import { TuningAdvice } from './Metrics'

/**
 * Settings: everything you set, in one place.
 *
 * The memory-tuning controls sit above the full settings list because they are
 * the two most consequential values on this page and the only ones with a live
 * recommendation attached. Machine state and measurements live on the
 * Dashboard; connecting other tools has its own view.
 */
export function SettingsView() {
  return (
    <div className="col">
      <TuningAdvice />
      <SettingsPage />
    </div>
  )
}
