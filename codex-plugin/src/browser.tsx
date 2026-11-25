import { createRoot } from 'react-dom/client'
import { SpecApi } from '../../src/client/api.ts'
import { SpecWorkbench } from '../../src/client/SpecWorkbench.tsx'
import css from '../../src/client/workbench.module.css'

createRoot(document.getElementById('workbench')!).render(
  <div className={css.nativeView} data-spec-collab-codex>
    <SpecWorkbench api={new SpecApi()} />
  </div>,
)
