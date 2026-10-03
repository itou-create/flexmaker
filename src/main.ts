import './styles.css'
import { initState, subscribe } from './state'
import { mountMap } from './ui/map'
import { mountPanel } from './ui/panel'
import { mountIntro } from './ui/intro'
import { emptyService, loadDraft, saveDraft } from './draft'

const app = document.getElementById('app')!
app.innerHTML = `
  <div class="layout">
    <div class="map-wrap">
      <div id="map" class="map" role="application" aria-label="地図"></div>
      <div id="map-overlay" class="map-overlay"></div>
    </div>
    <div id="panel" class="panel"></div>
  </div>
  <div id="intro" class="intro" hidden></div>
`

// 前回の入力があれば続きから（この端末の localStorage）。無ければ白紙
const draft = loadDraft()
initState({
  service: draft?.service ?? emptyService(),
  activeArea: draft?.activeArea ?? 0,
  mapMode: 'none',
  draftPolygon: [],
  issues: null,
})
subscribe((s) => saveDraft(s.service, s.activeArea))
mountMap(document.getElementById('map')!)
mountPanel(document.getElementById('panel')!, document.getElementById('map-overlay')!)
mountIntro(document.getElementById('intro')!)
