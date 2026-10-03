import './styles.css'
import { initState } from './state'
import { mountMap } from './ui/map'
import { mountPanel } from './ui/panel'
import { mountIntro } from './ui/intro'
import { emptyArea } from './gtfs/flexWriter'
import type { DemandService } from './types'

function emptyService(): DemandService {
  return {
    agency: { id: '', name: '', url: '', phone: '' },
    areas: [emptyArea(1)],
    feedPublisherName: '',
    feedPublisherUrl: '',
  }
}

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

initState({ service: emptyService(), activeArea: 0, mapMode: 'none', draftPolygon: [], issues: null })
mountMap(document.getElementById('map')!)
mountPanel(document.getElementById('panel')!, document.getElementById('map-overlay')!)
mountIntro(document.getElementById('intro')!)
