import { useStore } from '../store/useStore'
import { NewSessionModal } from './NewSessionModal'

/**
 * Compatibility entry point for existing Debate buttons. Creation now lives in
 * the shared Session/Debate launcher rather than a second, drifting form.
 */
export function NewRoundtableModal(): JSX.Element {
  const toggleNewRoundtable = useStore((state) => state.toggleNewRoundtable)
  return (
    <NewSessionModal
      initialMode="debate"
      onClose={() => toggleNewRoundtable(false)}
    />
  )
}
