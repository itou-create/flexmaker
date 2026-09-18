import './styles.css'
import { initState } from './state'
import { mountMap } from './ui/map'
import { mountPanel } from './ui/panel'
import { mountIntro } from './ui/intro'
import type { DemandService } from './types'

function emptyService(): DemandService {
  const y = new Date().getFullYear()
  return {
    agency: { id: '', name: '', url: '', phone: '' },
    routeId: '',
    routeName: '',
    pattern: 'zone_to_point',
    zone: undefined,
    stops: [],
    bookingRule: { id: 'booking_1', type: 2, priorNoticeLastDay: 1, priorNoticeLastTime: '17:00' },
    calendar: { id: 'service_1', days: [true, true, true, true, true, false, false], startDate: `${y}0401`, endDate: `${y + 1}0331` },
    windows: [{ start: '08:00', end: '17:00' }],
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

initState({ service: emptyService(), mapMode: 'none', draftPolygon: [], issues: null })
mountMap(document.getElementById('map')!)
mountPanel(document.getElementById('panel')!, document.getElementById('map-overlay')!)
mountIntro(document.getElementById('intro')!)
