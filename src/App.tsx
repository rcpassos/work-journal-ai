import type { Clock, Journal } from './journal/journal'
import {
  CAPTURE_WINDOW,
  MAIN_WINDOW,
  TASK_CREATION_WINDOW,
  type Desktop,
} from './platform/desktop'
import type { AppSettings } from './settings/app-settings'
import CaptureView from './views/capture/CaptureView'
import MainWindow from './views/main/MainWindow'
import TaskCreationView from './views/tasks/TaskCreationView'

/**
 * Every window loads the same bundle; the window label picks the view. An
 * unrecognised label renders nothing at all.
 *
 * The collaborators are built once in `main.tsx` and handed down from here, so
 * no view reaches for the platform itself.
 */
export default function App({
  windowLabel,
  desktop,
  settings,
  journal,
  clock,
}: {
  windowLabel: string
  desktop: Desktop
  settings: AppSettings
  journal: Promise<Journal>
  /** What the day is, for the views that group by it. */
  clock: Clock
}) {
  if (windowLabel === CAPTURE_WINDOW) {
    return <CaptureView desktop={desktop} journal={journal} />
  }

  if (windowLabel === TASK_CREATION_WINDOW) {
    return <TaskCreationView desktop={desktop} journal={journal} />
  }

  if (windowLabel === MAIN_WINDOW) {
    return (
      <MainWindow
        desktop={desktop}
        settings={settings}
        journal={journal}
        clock={clock}
      />
    )
  }

  return null
}
