'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ButtonHTMLAttributes, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Compass,
  Download,
  MapPin,
  LoaderCircle,
  LocateFixed,
  Route,
  Search,
  Sparkles,
  Trash2,
  Trees,
  Users,
  Wallet,
} from 'lucide-react'
import type { LatLngBounds, LatLngTuple, Map as LeafletMap } from 'leaflet'

type ApiDestination = {
  id: number
  name: string
  region: string
  description: string
  image_url: string | null
  tag: string | null
}

type DestinationSuggestion = {
  label: string
  title: string
  result_type: string
  city?: string | null
  state?: string | null
  country?: string | null
  latitude?: number | null
  longitude?: number | null
}

type Activity = {
  attraction_id: string | number
  place_id?: string
  name: string
  description: string
  category: string
  estimated_cost: number
  estimated_entry_fee_per_person: number
  entry_fee_known?: boolean
  visit_duration_minutes: number
  visit_duration_is_estimate?: boolean
  planning_notes: string | null
  address?: string | null
  latitude?: number | string | null
  longitude?: number | string | null
  lat?: number | string | null
  lng?: number | string | null
  lon?: number | string | null
  rating?: number | null
  maps_url?: string | null
  provider?: string
  costs_are_estimates?: boolean
}

type ItineraryDay = { day: number; activities: Activity[]; note?: string; theme?: string; route_path?: Array<{ latitude: number; longitude: number }>; travel_minutes_estimate?: number; travel_distance_km_estimate?: number; route_time_source?: string; route_path_source?: string }

type Trip = {
  id: number
  destination: string
  duration: number
  budget: number
  budget_currency?: 'INR' | 'USD'
  budget_input_amount?: number
  budget_exchange_rate?: number | null
  travelers: number
  transport: string
  interests: string[]
  itinerary: ItineraryDay[]
  planner_engine: string
  created_at: string
}

type ExplorePlace = {
  id: string
  place_id: string
  name: string
  description: string
  category: string
  address?: string | null
  latitude: number
  longitude: number
  maps_url?: string | null
  distance_from_destination_km: number
  recommendation_reason?: string
  provider?: string
  visit_duration_minutes?: number
}

type ExplorationRoute = {
  id: number
  title: string
  destination: string
  resolved_destination?: string
  interests: string[]
  transport: string
  radius_km: number
  places: Activity[]
  route_path: Array<{ latitude: number; longitude: number }>
  route_path_source: string
  travel_minutes_estimate: number
  travel_distance_km_estimate: number
  route_time_source: string
  note?: string
  created_at: string
}

type PlanRequest = {
  destination: string
  duration: number
  budget: number
  budget_currency: 'INR' | 'USD'
  travelers: number
  transport: string
  interests: string[]
}

type ApiErrorPayload = {
  error?: { code?: string; message?: string; details?: Record<string, string> }
}

class ApiError extends Error {
  status: number
  code?: string
  details?: Record<string, string>
  constructor(message: string, status: number, payload?: ApiErrorPayload) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = payload?.error?.code
    this.details = payload?.error?.details
  }
}

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'https://roamwise-api-a0ma.onrender.com/api'
).replace(/\/$/, '')

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Server issue, Please try again after a bit!', 0)
  }
  const payload = await response.json().catch(() => null) as T | ApiErrorPayload | null
  if (!response.ok) {
    const errorPayload = payload as ApiErrorPayload | null
    throw new ApiError(
      errorPayload?.error?.message ?? 'The planner could not complete that request.',
      response.status,
      errorPayload ?? undefined,
    )
  }
  return payload as T
}

async function searchDestinations(query = '', signal?: AbortSignal): Promise<ApiDestination[]> {
  const params = new URLSearchParams({ limit: '20' })
  if (query.trim()) params.set('q', query.trim())
  const result = await apiRequest<{ destinations: ApiDestination[] }>(`/destinations?${params.toString()}`, { signal })
  return result.destinations
}

async function autocompleteDestinations(query: string, signal?: AbortSignal): Promise<DestinationSuggestion[]> {
  const params = new URLSearchParams({ q: query.trim() })
  const result = await apiRequest<{ suggestions: DestinationSuggestion[] }>(`/destination-suggestions?${params.toString()}`, { signal })
  return result.suggestions
}

async function generatePlan(plan: PlanRequest): Promise<Trip> {
  const result = await apiRequest<{ trip: Trip }>('/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plan),
  })
  return result.trip
}

type ExchangeRateResponse = { base_currency: 'USD'; target_currency: 'INR'; rate: number; updated_at?: string | null; source?: string; attribution_url?: string }

async function fetchUsdInrRate(): Promise<ExchangeRateResponse> {
  return apiRequest<ExchangeRateResponse>('/exchange-rate')
}

async function getTrip(id: number): Promise<Trip> {
  const result = await apiRequest<{ trip: Trip }>(`/trips/${id}`)
  return result.trip
}

async function getSavedTrips(): Promise<Trip[]> {
  const result = await apiRequest<{ trips: Trip[] }>('/trips?limit=10')
  return result.trips
}

async function findOtherPlaces(payload: {
  destination: string
  interests: string[]
  transport: string
  exclude_names: string[]
}): Promise<{ places: ExplorePlace[]; resolved_destination: string; radius_km: number; note: string }> {
  return apiRequest<{ places: ExplorePlace[]; resolved_destination: string; radius_km: number; note: string }>('/explore/places', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

async function generateExplorationRoute(payload: {
  destination: string
  interests: string[]
  transport: string
  places: ExplorePlace[]
}): Promise<ExplorationRoute> {
  const result = await apiRequest<{ route: ExplorationRoute }>('/explore/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return result.route
}

async function getSavedExplorationRoutes(): Promise<ExplorationRoute[]> {
  const result = await apiRequest<{ routes: ExplorationRoute[] }>('/exploration-routes?limit=12')
  return result.routes
}

async function deleteExplorationRoute(id: number): Promise<void> {
  await apiRequest(`/exploration-routes/${id}`, { method: 'DELETE' })
}

function TiltCardButton({
  children,
  className = '',
  glowBorderColor = 'rgba(87, 220, 198, 0.45)',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; glowBorderColor?: string }) {
  const cardRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (isTouch || prefersReduced) return
    const maxTilt = 3.5
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const rect = card.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const rotateX = ((y - rect.height / 2) / (rect.height / 2)) * maxTilt
      const rotateY = -((x - rect.width / 2) / (rect.width / 2)) * maxTilt
      card.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-4px)`
      card.style.setProperty('--card-mouse-x', `${x}px`)
      card.style.setProperty('--card-mouse-y', `${y}px`)
      card.style.setProperty('--card-glow-opacity', '1')
      card.style.boxShadow = '0 20px 45px -12px rgba(0,0,0,0.35), 0 0 25px rgba(87,220,198,0.12)'
    }
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      card.style.transition = 'transform 0.12s ease-out, box-shadow 0.25s ease-out'
      card.style.setProperty('--card-glow-opacity', '1')
    }
    const onLeave = () => {
      card.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1), box-shadow 0.5s ease-out'
      card.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0px)'
      card.style.setProperty('--card-glow-opacity', '0')
      card.style.boxShadow = ''
    }
    card.addEventListener('pointermove', onMove, { passive: true })
    card.addEventListener('pointerenter', onEnter, { passive: true })
    card.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      card.removeEventListener('pointermove', onMove)
      card.removeEventListener('pointerenter', onEnter)
      card.removeEventListener('pointerleave', onLeave)
    }
  }, [])
  return (
    <button ref={cardRef} style={{ transformStyle: 'preserve-3d', willChange: 'transform', ...style }} className={`group relative text-left ${className}`} {...props}>
      <span className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-300" style={{ opacity: 'var(--card-glow-opacity, 0)', background: 'radial-gradient(320px circle at var(--card-mouse-x, 50%) var(--card-mouse-y, 50%), rgba(87, 220, 198, 0.12), transparent 75%)' }} aria-hidden="true" />
      <span className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-300" style={{ opacity: 'var(--card-glow-opacity, 0)', background: `radial-gradient(280px circle at var(--card-mouse-x, 50%) var(--card-mouse-y, 50%), ${glowBorderColor}, transparent 70%)`, mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', maskComposite: 'exclude', WebkitMaskComposite: 'xor', padding: '1px' }} aria-hidden="true" />
      {children}
    </button>
  )
}

type MapStop = {
  key: string
  day: number
  stopNumber: number
  name: string
  description: string
  address?: string | null
  duration: number
  fee: number
  feeKnown: boolean
  position: LatLngTuple
}

const MAP_DAY_COLORS = ['#57DCC6', '#AFA6FF', '#F5C36B', '#8DCBFF', '#FF9CBA', '#B2E58D', '#F3A67E']
const LEGACY_COORDINATES: Record<string, LatLngTuple> = {
  'the metropolitan museum of art': [40.7794, -73.9632],
  'the met': [40.7794, -73.9632],
  'central park': [40.7829, -73.9654],
  'brooklyn bridge': [40.7061, -73.9969],
  'times square': [40.758, -73.9855],
}

function activityPosition(activity: Activity): LatLngTuple | null {
  const rawLat = activity.latitude ?? activity.lat
  const rawLng = activity.longitude ?? activity.lng ?? activity.lon
  if (rawLat !== undefined && rawLat !== null && rawLng !== undefined && rawLng !== null) {
    const lat = Number(rawLat)
    const lng = Number(rawLng)
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return [lat, lng]
  }
  return LEGACY_COORDINATES[activity.name.trim().toLowerCase()] ?? null
}

function ItineraryMap({ destination, itinerary }: { destination: string; itinerary: ItineraryDay[] }) {
  const mapElementRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<LeafletMap | null>(null)
  const mapBoundsRef = useRef<LatLngBounds | null>(null)
  const [routeStatus, setRouteStatus] = useState<'loading' | 'ready' | 'partial' | 'unavailable'>('loading')
  const [mapError, setMapError] = useState(false)
  const stops = useMemo(() => {
    const result: MapStop[] = []
    for (const day of itinerary) {
      let stopNumber = 0
      for (const activity of day.activities) {
        const position = activityPosition(activity)
        if (!position) continue
        stopNumber += 1
        result.push({
          key: `${day.day}-${activity.attraction_id}-${stopNumber}`,
          day: day.day,
          stopNumber,
          name: activity.name,
          description: activity.description,
          address: activity.address,
          duration: activity.visit_duration_minutes,
          fee: activity.estimated_entry_fee_per_person,
          feeKnown: activity.entry_fee_known === true,
          position,
        })
      }
    }
    return result
  }, [itinerary])
  const activityCount = itinerary.reduce((sum, day) => sum + day.activities.length, 0)

  const recenterMap = () => {
    const currentMap = mapInstanceRef.current
    const currentBounds = mapBoundsRef.current
    if (!currentMap || !currentBounds?.isValid()) return
    currentMap.invalidateSize({ pan: false })
    currentMap.fitBounds(currentBounds, {
      padding: [42, 42],
      maxZoom: stops.length === 1 ? 14 : 13,
      animate: true,
      duration: 0.35,
    })
  }

  useEffect(() => {
    let cancelled = false
    let map: LeafletMap | null = null
    const initialize = async () => {
      if (!mapElementRef.current || stops.length === 0) {
        setRouteStatus('unavailable')
        return
      }
      try {
        const L = await import('leaflet')
        if (cancelled || !mapElementRef.current) return
        setMapError(false)
        setRouteStatus('loading')
        map = L.map(mapElementRef.current, { scrollWheelZoom: true, zoomControl: true, preferCanvas: true })
        mapInstanceRef.current = map
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        }).addTo(map)

        const markerGroup = L.featureGroup()
        for (const stop of stops) {
          const color = MAP_DAY_COLORS[(stop.day - 1) % MAP_DAY_COLORS.length]
          const marker = L.circleMarker(stop.position, {
            radius: 10, color: '#071522', weight: 3, fillColor: color, fillOpacity: 1,
          }).addTo(markerGroup)
          marker.bindTooltip(`DAY ${stop.day} · STOP ${stop.stopNumber}`, {
            permanent: true, direction: 'top', offset: L.point(0, -7), className: 'roamwise-map-tooltip',
          })
          const popup = document.createElement('div')
          popup.style.minWidth = '170px'
          const label = document.createElement('div')
          label.textContent = `DAY ${stop.day} · STOP ${stop.stopNumber}`
          label.style.cssText = `margin-bottom:5px;color:${color};font-size:11px;font-weight:800;letter-spacing:.08em`
          const title = document.createElement('strong')
          title.textContent = stop.name
          title.style.cssText = 'display:block;color:#102331;font-size:14px'
          const detail = document.createElement('p')
          const feeText = stop.feeKnown ? `₹${stop.fee.toLocaleString('en-IN')} entry/person (estimate)` : 'entry fee not verified'
          detail.textContent = `${stop.duration} min · ${feeText}${stop.address ? ` · ${stop.address}` : ''}`
          detail.style.cssText = 'margin:5px 0 0;color:#526575;font-size:12px'
          popup.append(label, title, detail)
          marker.bindPopup(popup)
        }
        markerGroup.addTo(map)
        const bounds = markerGroup.getBounds()
        // Include backend route geometry in the initial viewport. This matters for
        // single-stop fallback paths that begin at the destination's city center.
        for (const day of itinerary) {
          for (const point of day.route_path || []) {
            const lat = Number(point.latitude)
            const lng = Number(point.longitude)
            if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) bounds.extend([lat, lng])
          }
        }
        mapBoundsRef.current = bounds
        if (stops.length === 1 && !(itinerary.some((day) => (day.route_path || []).length >= 2))) map.setView(stops[0].position, 13, { animate: false })
        else if (bounds.isValid()) map.fitBounds(bounds, { padding: [38, 38], maxZoom: 13, animate: false })
        window.setTimeout(() => { if (!cancelled) map?.invalidateSize() }, 150)

        const byDay = new Map<number, MapStop[]>()
        for (const stop of stops) byDay.set(stop.day, [...(byDay.get(stop.day) ?? []), stop])
        let routesLoaded = 0
        let failures = 0
        for (const [day, dayStops] of byDay) {
          if (cancelled) return

          // Check backend geometry before guarding on the marker count: exploration
          // routes may contain one selected stop plus the destination-center origin.
          const backendPath = itinerary.find((item) => item.day === day)?.route_path ?? []
          const backendLatLngs = backendPath
            .map((point) => [Number(point.latitude), Number(point.longitude)] as LatLngTuple)
            .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
          if (backendLatLngs.length >= 2 && map) {
            const pathSource = itinerary.find((item) => item.day === day)?.route_path_source || ''
            const approximate = pathSource.toLowerCase().includes('straight-line')
            L.polyline(backendLatLngs, {
              color: MAP_DAY_COLORS[(day - 1) % MAP_DAY_COLORS.length],
              weight: approximate ? 3 : 5,
              opacity: approximate ? 0.62 : 0.92,
              dashArray: approximate ? '7 8' : undefined,
              lineCap: 'round', lineJoin: 'round',
            }).addTo(map)
            routesLoaded += 1
            if (approximate) failures += 1
            continue
          }

          if (dayStops.length < 2) continue
          const coordinateString = dayStops.map(stop => `${stop.position[1]},${stop.position[0]}`).join(';')
          try {
            const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinateString}?overview=full&geometries=geojson&steps=false`, { signal: AbortSignal.timeout(12000) })
            if (!response.ok) throw new Error('Road route unavailable')
            const data = await response.json()
            const coordinates = data?.routes?.[0]?.geometry?.coordinates
            if (!Array.isArray(coordinates) || coordinates.length < 2) throw new Error('No route geometry')
            const latLngs = coordinates.map((point: unknown) => {
              const pair = point as [number, number]
              return [Number(pair[1]), Number(pair[0])] as LatLngTuple
            })
            if (!cancelled && map) {
              L.polyline(latLngs, { color: MAP_DAY_COLORS[(day - 1) % MAP_DAY_COLORS.length], weight: 5, opacity: 0.92, lineCap: 'round', lineJoin: 'round' }).addTo(map)
              for (const point of latLngs) bounds.extend(point)
              mapBoundsRef.current = bounds
              routesLoaded += 1
            }
          } catch {
            failures += 1
          }
        }
        if (!cancelled) setRouteStatus(routesLoaded === 0 ? 'unavailable' : failures > 0 ? 'partial' : 'ready')
      } catch {
        if (!cancelled) {
          setMapError(true)
          setRouteStatus('unavailable')
        }
      }
    }
    void initialize()
    return () => {
      cancelled = true
      map?.remove()
      if (mapInstanceRef.current === map) mapInstanceRef.current = null
      mapBoundsRef.current = null
    }
  }, [stops, itinerary])

  // Leaflet recalculates its viewport when the print layout narrows the map.
  useEffect(() => {
    const refreshSelectedMapForPrint = () => {
      const requestedTarget = document.body.getAttribute('data-roamwise-pdf-target')
      const element = mapElementRef.current
      if (!requestedTarget || !element) return
      const resultSection = element.closest('#generated-itinerary, #active-exploration-route')
      const mapTarget = resultSection?.id === 'generated-itinerary'
        ? 'itinerary'
        : resultSection?.id === 'active-exploration-route'
          ? 'exploration'
          : null
      if (mapTarget !== requestedTarget) return
      const currentMap = mapInstanceRef.current
      const currentBounds = mapBoundsRef.current
      if (!currentMap) return
      currentMap.invalidateSize({ pan: false })
      if (currentBounds?.isValid()) {
        currentMap.fitBounds(currentBounds, { padding: [38, 38], maxZoom: 13, animate: false })
      }
    }
    window.addEventListener('beforeprint', refreshSelectedMapForPrint)
    return () => window.removeEventListener('beforeprint', refreshSelectedMapForPrint)
  }, [])

  if (stops.length === 0 || mapError) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(87,220,198,0.09),transparent_60%),#081b28] px-6 text-center sm:min-h-[390px]">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-[#57DCC6]/25 bg-[#123b45] text-2xl text-[#78E7D4]">⌖</span>
        <h3 className="mt-4 text-base font-bold text-white">{mapError ? 'Map could not be loaded' : 'Map coordinates are not available'}</h3>
        <p className="mt-2 max-w-md text-sm leading-6 text-[#9CB5C6]">{mapError ? 'Check your connection and reload the trip to try the map again.' : `No verified coordinates were returned for the stops in ${destination}. The itinerary is still available below.`}</p>
      </div>
    )
  }

  const days = Array.from(new Set(stops.map(stop => stop.day)))
  return (
    <div className="relative h-[320px] w-full bg-[#0a1d2a] sm:h-[390px] lg:h-[440px]">
      <div ref={mapElementRef} data-route-status={routeStatus} className="h-full w-full" aria-label={`Interactive itinerary map for ${destination}`} />
      <button
        type="button"
        onClick={recenterMap}
        title="Show all places"
        aria-label="Recenter map to show all places and route"
        className="pdf-hide absolute right-3 top-[60px] z-[500] grid h-11 w-11 place-items-center rounded-xl border border-white/15 bg-[#071522]/95 text-[#8AECDD] shadow-xl backdrop-blur transition hover:border-[#57DCC6]/60 hover:bg-[#0E2A38] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#57DCC6]"
      >
        <LocateFixed size={19} aria-hidden="true" />
      </button>
      <div className="pointer-events-none absolute bottom-3 left-3 z-[400] flex flex-wrap gap-2">
        {days.map(day => <span key={day} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#071522]/90 px-3 py-1.5 text-[11px] font-bold text-white shadow-lg backdrop-blur"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: MAP_DAY_COLORS[(day - 1) % MAP_DAY_COLORS.length] }} />DAY {day}</span>)}
      </div>
      <div className="absolute right-3 top-3 z-[400] max-w-[245px] rounded-lg border border-white/10 bg-[#071522]/90 px-3 py-2 text-[11px] leading-4 text-[#D5E5EF] shadow-lg backdrop-blur">
        {routeStatus === 'loading' ? 'Finding road routes…' : routeStatus === 'ready' ? (itinerary.some((day) => day.route_path_source?.toLowerCase().includes('destination center')) ? 'OSRM route preview · single-stop days start at the destination center' : 'Road routes via OSRM · driving-route preview') : routeStatus === 'partial' ? (itinerary.some((day) => day.route_path_source?.toLowerCase().includes('straight-line')) ? 'Dashed lines are approximate; road routing was unavailable.' : 'Some road routes are unavailable; markers remain visible.') : 'Road routing unavailable. Showing place markers.'}
      </div>
      {stops.length < activityCount && <div className="absolute bottom-14 right-3 z-[400] max-w-[230px] rounded-lg border border-amber-200/20 bg-[#071522]/90 px-3 py-2 text-[11px] leading-4 text-amber-100 shadow-lg backdrop-blur">Showing {stops.length} of {activityCount} stops. Some old saved attractions have no coordinates.</div>}
    </div>
  )
}

type View = 'home' | 'explore' | 'plan'

type DestinationCard = {
  id?: number
  name: string
  region: string
  description: string
  image: string
  tag: string
}

const fallbackDestinations: DestinationCard[] = [
  {
    name: 'Tokyo',
    region: 'Japan',
    description: 'Neon-lit streets, peaceful shrines, incredible food and pop culture.',
    image: 'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=900&q=85',
    tag: 'City & culture',
  },
  {
    name: 'Paris',
    region: 'France',
    description: 'World-class art, café-lined streets, river walks and iconic landmarks.',
    image: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=900&q=85',
    tag: 'Art & romance',
  },
  {
    name: 'London',
    region: 'United Kingdom',
    description: 'Historic landmarks, lively markets, museums and theatre nights.',
    image: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=900&q=85',
    tag: 'History & city life',
  },
  {
    name: 'New York',
    region: 'United States',
    description: 'Iconic parks, neighbourhoods, museums and skyline views.',
    image: 'https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?auto=format&fit=crop&w=900&q=85',
    tag: 'City icons',
  },
  {
    name: 'Singapore',
    region: 'Singapore',
    description: 'Futuristic gardens, waterfront architecture and legendary hawker food.',
    image: 'https://images.unsplash.com/photo-1525625293386-3f8f99389edd?auto=format&fit=crop&w=900&q=85',
    tag: 'Food & skyline',
  },
  {
    name: 'Bali',
    region: 'Indonesia',
    description: 'Lush rice terraces, volcanic scenery, temples and surf beaches.',
    image: 'https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=900&q=85',
    tag: 'Island escape',
  },
  {
    name: 'Rome',
    region: 'Italy',
    description: 'Ancient ruins, grand piazzas, art and unforgettable Italian food.',
    image: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=900&q=85',
    tag: 'Ancient history',
  },
  {
    name: 'Dubai',
    region: 'United Arab Emirates',
    description: 'Modern architecture, desert experiences, souks and waterfront dining.',
    image: 'https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=900&q=85',
    tag: 'Modern & desert',
  },
  {
    name: 'Bangkok',
    region: 'Thailand',
    description: 'Golden temples, night markets, river trips and bold street food.',
    image: 'https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=900&q=85',
    tag: 'Food & temples',
  },
  {
    name: 'Puri',
    region: 'Odisha, India',
    description: 'Temple heritage, ocean sunsets and local Odia food.',
    image: 'https://images.unsplash.com/photo-1593693397690-362cb9666fc2?auto=format&fit=crop&w=900&q=85',
    tag: 'Culture & coast',
  },
  {
    name: 'Goa',
    region: 'India',
    description: 'Beach days, Portuguese heritage and laid-back cafés.',
    image: 'https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=900&q=85',
    tag: 'Beach escape',
  },
  {
    name: 'Jaipur',
    region: 'Rajasthan, India',
    description: 'Colourful markets, forts and beautiful architecture.',
    image: 'https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=900&q=85',
    tag: 'History & culture',
  },
]

const interestOptions = ['Nature', 'History', 'Local food', 'Adventure', 'Photography', 'Popular / hot']

const fieldClass = 'w-full rounded-xl border border-[#2B4A60] bg-[#091B2A] px-4 py-3 text-[#ECF5FC] outline-none transition placeholder:text-[#7E98AA] focus:border-[#57DCC6] focus:ring-2 focus:ring-[#57DCC6]/15'
const fieldLabelClass = 'block text-sm font-semibold text-[#D9E7F1]'
const formatINR = (amount: number) => `₹${amount.toLocaleString('en-IN')}`
const formatBudgetCurrency = (amount: number, currency: 'INR' | 'USD') => new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'en-IN', {
  style: 'currency', currency, maximumFractionDigits: currency === 'USD' ? 2 : 0,
}).format(amount)

const toDestinationCard = (destination: ApiDestination): DestinationCard => ({
  id: destination.id,
  name: destination.name,
  region: destination.region,
  description: destination.description,
  image: destination.image_url || 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=900&q=85',
  tag: destination.tag || 'Travel destination',
})

export default function Home() {
  const [view, setView] = useState<View>('home')
  const [search, setSearch] = useState('')
  const [destination, setDestination] = useState('New York')
  const [destinationSuggestionsOpen, setDestinationSuggestionsOpen] = useState(false)
  const [destinationSuggestions, setDestinationSuggestions] = useState<DestinationSuggestion[]>([])
  const [destinationSuggestionsLoading, setDestinationSuggestionsLoading] = useState(false)
  const [destinationSuggestionsError, setDestinationSuggestionsError] = useState<string | null>(null)
  const [activeDestinationSuggestionIndex, setActiveDestinationSuggestionIndex] = useState(-1)
  const [duration, setDuration] = useState('2')
  const [budget, setBudget] = useState('5000')
  const [budgetCurrency, setBudgetCurrency] = useState<'INR' | 'USD'>('INR')
  const [usdInrRate, setUsdInrRate] = useState<number | null>(null)
  const [usdInrRateDate, setUsdInrRateDate] = useState<string | null>(null)
  const [usdInrRateSource, setUsdInrRateSource] = useState<string | null>(null)
  const [currencyRateLoading, setCurrencyRateLoading] = useState(false)
  const [currencyRateError, setCurrencyRateError] = useState<string | null>(null)
  const [travelers, setTravelers] = useState('2')
  const [transport, setTransport] = useState('Flexible')
  const [interests, setInterests] = useState<string[]>(['History', 'Local food'])
  const [apiDestinations, setApiDestinations] = useState<ApiDestination[]>([])
  const [exploreDestinations, setExploreDestinations] = useState<ApiDestination[]>([])
  const [exploreError, setExploreError] = useState<string | null>(null)
  const [hasLoadedExploreDestinations, setHasLoadedExploreDestinations] = useState(false)
  const [successfulExploreQuery, setSuccessfulExploreQuery] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [trip, setTrip] = useState<Trip | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [savedTrips, setSavedTrips] = useState<Trip[]>([])
  const [savedTripsError, setSavedTripsError] = useState<string | null>(null)
  const [savedTripsExpanded, setSavedTripsExpanded] = useState(false)
  const [openingTripId, setOpeningTripId] = useState<number | null>(null)
  const [otherPlaces, setOtherPlaces] = useState<ExplorePlace[]>([])
  const [otherPlacesLoaded, setOtherPlacesLoaded] = useState(false)
  const [otherPlacesLoading, setOtherPlacesLoading] = useState(false)
  const [otherPlacesError, setOtherPlacesError] = useState<string | null>(null)
  const [selectedOtherPlaceIds, setSelectedOtherPlaceIds] = useState<string[]>([])
  const [generatingExplorationRoute, setGeneratingExplorationRoute] = useState(false)
  const [explorationRouteError, setExplorationRouteError] = useState<string | null>(null)
  const [activeExplorationRoute, setActiveExplorationRoute] = useState<ExplorationRoute | null>(null)
  const [savedExplorationRoutes, setSavedExplorationRoutes] = useState<ExplorationRoute[]>([])
  const [savedExplorationRoutesExpanded, setSavedExplorationRoutesExpanded] = useState(false)
  const [savedExplorationRoutesError, setSavedExplorationRoutesError] = useState<string | null>(null)
  const [deletingExplorationRouteId, setDeletingExplorationRouteId] = useState<number | null>(null)
  const [pdfPreparing, setPdfPreparing] = useState<'itinerary' | 'exploration' | null>(null)
  const appRootRef = useRef<HTMLElement>(null)
  const spotlightRef = useRef<HTMLDivElement>(null)

  const clearPlanResult = () => {
    setTrip(null)
    setPlanError(null)
    setOtherPlaces([])
    setOtherPlacesLoaded(false)
    setOtherPlacesError(null)
    setSelectedOtherPlaceIds([])
    setActiveExplorationRoute(null)
    setExplorationRouteError(null)
  }

  const loadSavedTrips = async () => {
    try {
      const saved = await getSavedTrips()
      setSavedTrips(saved)
      setSavedTripsError(null)
    } catch (error) {
      setSavedTripsError(error instanceof Error ? error.message : 'Saved trips could not be loaded.')
    }
  }

  const loadSavedExplorationRoutes = async () => {
    try {
      const saved = await getSavedExplorationRoutes()
      setSavedExplorationRoutes(saved)
      setSavedExplorationRoutesError(null)
    } catch (error) {
      setSavedExplorationRoutesError(error instanceof Error ? error.message : 'Saved exploration routes could not be loaded.')
    }
  }

  useEffect(() => {
    let active = true
    searchDestinations()
      .then((items) => {
        if (!active) return
        setApiDestinations(items)
        setExploreDestinations(items)
        setHasLoadedExploreDestinations(true)
      })
      .catch(() => {
        // The Explore screen identifies its intentional local visual fallback.
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (view !== 'explore') {
      setIsSearching(false)
      return
    }
    const controller = new AbortController()
    // Show a loading state immediately; only debounce the network request.
    setIsSearching(true)
    setExploreError(null)
    setSuccessfulExploreQuery(null)
    const timer = window.setTimeout(async () => {
      try {
        // The client owns the request lifetime; API errors retain a readable fallback.
        const items = await searchDestinations(search, controller.signal)
        if (!controller.signal.aborted) {
          setExploreDestinations(items)
          setExploreError(null)
          setHasLoadedExploreDestinations(true)
          setSuccessfulExploreQuery(search.trim())
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setExploreError(error instanceof Error ? error.message : 'Destination search is unavailable.')
        }
      } finally {
        if (!controller.signal.aborted) setIsSearching(false)
      }
    }, 220)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [view, search])

  useEffect(() => {
    if (view === 'plan') {
      void loadSavedTrips()
      void loadSavedExplorationRoutes()
    }
  }, [view])


  // Live Geoapify autocomplete for destination input. Requests are debounced and cancelled
  // when the user keeps typing or closes the menu, so old results do not replace newer ones.
  useEffect(() => {
    const query = destination.trim()
    if (!destinationSuggestionsOpen || query.length < 2) {
      setDestinationSuggestions([])
      setDestinationSuggestionsLoading(false)
      setDestinationSuggestionsError(null)
      setActiveDestinationSuggestionIndex(-1)
      return
    }

    const controller = new AbortController()
    // Clear results from the previous query immediately while the new request is debounced.
    setDestinationSuggestions([])
    setActiveDestinationSuggestionIndex(-1)
    setDestinationSuggestionsError(null)
    setDestinationSuggestionsLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const items = await autocompleteDestinations(query, controller.signal)
        if (!controller.signal.aborted) {
          setDestinationSuggestions(items)
          setActiveDestinationSuggestionIndex(-1)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setDestinationSuggestions([])
          setDestinationSuggestionsError(error instanceof Error ? error.message : 'Destination autocomplete is unavailable.')
          setActiveDestinationSuggestionIndex(-1)
        }
      } finally {
        if (!controller.signal.aborted) setDestinationSuggestionsLoading(false)
      }
    }, 280)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [destination, destinationSuggestionsOpen])

  // Cursor-following ambient glow is shared by Home, Explore, and Plan a trip.
  useEffect(() => {
    const appRoot = appRootRef.current
    const spotlight = spotlightRef.current
    if (!appRoot || !spotlight) return

    // Respect touch-first devices and reduced-motion preferences.
    const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (isTouch || prefersReduced) return

    let animationFrameId: number | null = null
    let currentX = 0
    let currentY = 0
    let targetX = 0
    let targetY = 0
    let isHovering = false
    let isMoving = false

    const updatePosition = () => {
      currentX += (targetX - currentX) * 0.08
      currentY += (targetY - currentY) * 0.08
      spotlight.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`

      const dx = Math.abs(targetX - currentX)
      const dy = Math.abs(targetY - currentY)
      if (isHovering || dx > 0.1 || dy > 0.1) {
        animationFrameId = requestAnimationFrame(updatePosition)
      } else {
        isMoving = false
        animationFrameId = null
      }
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const rect = appRoot.getBoundingClientRect()
      targetX = event.clientX - rect.left
      targetY = event.clientY - rect.top

      if (!isHovering) {
        isHovering = true
        spotlight.style.opacity = '1'
        if (!isMoving) {
          currentX = targetX
          currentY = targetY
          spotlight.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`
        }
      }

      if (!isMoving) {
        isMoving = true
        animationFrameId = requestAnimationFrame(updatePosition)
      }
    }

    const handlePointerLeave = () => {
      isHovering = false
      spotlight.style.opacity = '0'
    }

    appRoot.addEventListener('pointermove', handlePointerMove, { passive: true })
    appRoot.addEventListener('pointerleave', handlePointerLeave, { passive: true })
    return () => {
      appRoot.removeEventListener('pointermove', handlePointerMove)
      appRoot.removeEventListener('pointerleave', handlePointerLeave)
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId)
    }
  }, [])

  // Keep the visible app view in the browser history so Back/Forward stays
  // inside RoamWise instead of navigating away from the site.
  useEffect(() => {
    const viewForHash = (): View => {
      const hash = window.location.hash.toLowerCase()
      if (hash === '#explore') return 'explore'
      if (hash === '#planner' || hash === '#plan') return 'plan'
      return 'home'
    }

    // If someone opens a planner/explore hash directly (or reloads an older
    // link), create an in-app Home history entry so Back still returns here.
    const initialView = viewForHash()
    const currentState = (window.history.state ?? {}) as { roamwiseView?: View; [key: string]: unknown }
    const baseUrl = `${window.location.pathname}${window.location.search}`

    if (initialView !== 'home' && currentState.roamwiseView !== initialView) {
      window.history.replaceState({ ...currentState, roamwiseView: 'home' }, '', baseUrl)
      const initialHash = initialView === 'explore' ? '#explore' : '#planner'
      window.history.pushState({ ...(window.history.state ?? {}), roamwiseView: initialView }, '', `${baseUrl}${initialHash}`)
    } else {
      window.history.replaceState({ ...currentState, roamwiseView: initialView }, '', window.location.href)
    }
    setView(initialView)

    const readViewFromUrl = () => setView(viewForHash())
    window.addEventListener('popstate', readViewFromUrl)
    window.addEventListener('hashchange', readViewFromUrl)
    return () => {
      window.removeEventListener('popstate', readViewFromUrl)
      window.removeEventListener('hashchange', readViewFromUrl)
    }
  }, [])

  const navigateToView = (nextView: View) => {
    const nextHash = nextView === 'home' ? '' : nextView === 'explore' ? '#explore' : '#planner'
    const currentHash = window.location.hash.toLowerCase()

    if (currentHash !== nextHash) {
      const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`
      window.history.pushState({ ...(window.history.state ?? {}), roamwiseView: nextView }, '', nextUrl)
    }

    setView(nextView)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const fallbackSearchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return fallbackDestinations
    return fallbackDestinations.filter((place) =>
      `${place.name} ${place.region} ${place.tag}`.toLowerCase().includes(query),
    )
  }, [search])

  const filteredDestinations = useMemo(
    () => (exploreError || isSearching || !hasLoadedExploreDestinations ? fallbackSearchResults : exploreDestinations.map(toDestinationCard)),
    [exploreDestinations, exploreError, fallbackSearchResults, hasLoadedExploreDestinations, isSearching],
  )


  const selectDestinationSuggestion = (suggestion: DestinationSuggestion) => {
    setDestination(suggestion.label)
    setDestinationSuggestionsOpen(false)
    setActiveDestinationSuggestionIndex(-1)
    setDestinationSuggestionsError(null)
    clearPlanResult()
  }

  const openPlanner = (place?: string) => {
    if (place) setDestination(place)
    clearPlanResult()
    navigateToView('plan')
  }

  const toggleInterest = (interest: string) => {
    setInterests((current) =>
      current.includes(interest)
        ? current.filter((item) => item !== interest)
        : [...current, interest],
    )
  }

  const allInterestsSelected = interestOptions.every((interest) => interests.includes(interest))

  const toggleAllInterests = () => {
    setInterests(allInterestsSelected ? [] : [...interestOptions])
    clearPlanResult()
  }

  const changeBudgetCurrency = async (nextCurrency: 'INR' | 'USD') => {
    if (nextCurrency === budgetCurrency) return
    setCurrencyRateError(null)
    let rate = usdInrRate
    if (!rate) {
      setCurrencyRateLoading(true)
      try {
        const exchange = await fetchUsdInrRate()
        rate = exchange.rate
        setUsdInrRate(exchange.rate)
        setUsdInrRateDate(exchange.updated_at ?? null)
        setUsdInrRateSource(exchange.source ?? 'ExchangeRate-API')
      } catch (error) {
        setCurrencyRateError(error instanceof Error ? error.message : 'Could not load the USD/INR reference rate.')
        setCurrencyRateLoading(false)
        return
      } finally {
        setCurrencyRateLoading(false)
      }
    }
    if (!rate || !Number.isFinite(rate) || rate <= 0) return
    const currentAmount = Number(budget) || 0
    const converted = budgetCurrency === 'INR' && nextCurrency === 'USD'
      ? currentAmount / rate
      : currentAmount * rate
    const nextMin = nextCurrency === 'INR' ? 500 : Math.ceil((500 / rate) * 100) / 100
    const nextMax = nextCurrency === 'INR' ? 100000 : Math.floor((100000 / rate) * 100) / 100
    const normalized = nextCurrency === 'INR'
      ? Math.round(converted)
      : Math.ceil(converted * 100) / 100
    setBudget(String(Math.min(nextMax, Math.max(nextMin, normalized))))
    setBudgetCurrency(nextCurrency)
    clearPlanResult()
  }

  const budgetMin = budgetCurrency === 'INR' ? 500 : Math.max(1, Math.ceil((500 / (usdInrRate || 87)) * 100) / 100)
  const budgetMax = budgetCurrency === 'INR' ? 100000 : Math.floor((100000 / (usdInrRate || 87)) * 100) / 100

  const downloadResultPdf = async (target: 'itinerary' | 'exploration') => {
    if (target === 'itinerary' && !trip) return
    if (target === 'exploration' && !activeExplorationRoute) return

    const sectionId = target === 'itinerary' ? 'generated-itinerary' : 'active-exploration-route'
    const section = document.getElementById(sectionId)
    if (!section) return

    const originalTitle = document.title
    const originalTarget = document.body.getAttribute('data-roamwise-pdf-target')
    const titleSubject = target === 'itinerary'
      ? `${trip!.destination} - ${trip!.duration}-day itinerary`
      : `${activeExplorationRoute!.destination} - extra places route`
    let restored = false
    const restorePrintState = () => {
      if (restored) return
      restored = true
      document.title = originalTitle
      if (originalTarget === null) document.body.removeAttribute('data-roamwise-pdf-target')
      else document.body.setAttribute('data-roamwise-pdf-target', originalTarget)
      window.removeEventListener('afterprint', restorePrintState)
      setPdfPreparing(null)
    }

    setPdfPreparing(target)
    document.body.setAttribute('data-roamwise-pdf-target', target)
    document.title = `RoamWise - ${titleSubject}`
    window.addEventListener('afterprint', restorePrintState)

    try {
      // Give the Leaflet map time to finish drawing its route before the print snapshot.
      const routeDeadline = Date.now() + 15000
      while (Date.now() < routeDeadline && section.querySelector('[data-route-status="loading"]')) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 150))
      }

      // Wait briefly for current map tiles and other images. A failed tile should not block export.
      const pendingImages = Array.from(section.querySelectorAll('img')).filter((image) => !image.complete)
      if (pendingImages.length > 0) {
        await Promise.race([
          Promise.all(pendingImages.map((image) => new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true })
            image.addEventListener('error', () => resolve(), { once: true })
          }))),
          new Promise<void>((resolve) => window.setTimeout(resolve, 5000)),
        ])
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
      window.print()
    } catch {
      window.alert('The PDF could not be prepared. Wait for the map to load, then try again.')
    } finally {
      window.setTimeout(restorePrintState, 1200)
    }
  }

  const generateItinerary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const parsedDuration = Number(duration)
    const parsedBudget = Number(budget)
    const parsedTravelers = Number(travelers)
    if (!destination.trim() || !Number.isInteger(parsedDuration) || !Number.isFinite(parsedBudget) || !Number.isInteger(parsedTravelers)) {
      setPlanError('Please provide a destination, duration, total budget, and number of travelers.')
      return
    }
    setIsGenerating(true)
    setPlanError(null)
    setTrip(null)
    setOtherPlaces([])
    setOtherPlacesLoaded(false)
    setOtherPlacesError(null)
    setSelectedOtherPlaceIds([])
    setActiveExplorationRoute(null)
    setExplorationRouteError(null)
    try {
      const generatedTrip = await generatePlan({
        destination: destination.trim(),
        duration: parsedDuration,
        budget: parsedBudget,
        budget_currency: budgetCurrency,
        travelers: parsedTravelers,
        transport,
        interests,
      })
      setTrip(generatedTrip)
      setBudgetCurrency(generatedTrip.budget_currency ?? budgetCurrency)
      setBudget(String(generatedTrip.budget_input_amount ?? parsedBudget))
      setSavedTrips((current) => [generatedTrip, ...current.filter((saved) => saved.id !== generatedTrip.id)])
    } catch (error) {
      const suffix = error instanceof ApiError && error.details
        ? ` ${Object.values(error.details).join(' ')}`
        : ''
      setPlanError(`${error instanceof Error ? error.message : 'The itinerary could not be generated.'}${suffix}`)
    } finally {
      setIsGenerating(false)
    }
  }

  const discoverOtherPlaces = async () => {
    if (!trip) return
    setOtherPlacesLoading(true)
    setOtherPlacesError(null)
    setOtherPlacesLoaded(false)
    setSelectedOtherPlaceIds([])
    setExplorationRouteError(null)
    try {
      const excludeNames = trip.itinerary.flatMap((day) => day.activities.map((activity) => activity.name))
      const result = await findOtherPlaces({
        destination: trip.destination,
        interests: trip.interests,
        transport: trip.transport,
        exclude_names: excludeNames,
      })
      setOtherPlaces(result.places)
      setOtherPlacesLoaded(true)
      if (result.places.length === 0) {
        setOtherPlacesError('No additional places could be verified within 100 km this time. Try refreshing or broadening your interests.')
      }
    } catch (error) {
      setOtherPlacesError(error instanceof Error ? error.message : 'Nearby place discovery failed. Your main itinerary is unchanged.')
    } finally {
      setOtherPlacesLoading(false)
    }
  }

  const toggleOtherPlace = (placeId: string) => {
    setSelectedOtherPlaceIds((current) => current.includes(placeId)
      ? current.filter((id) => id !== placeId)
      : current.length < 8 ? [...current, placeId] : current)
    setExplorationRouteError(null)
  }

  const createExplorationRoute = async () => {
    if (!trip) return
    const selected = otherPlaces.filter((place) => selectedOtherPlaceIds.includes(place.id))
    if (selected.length === 0) {
      setExplorationRouteError('Select at least one additional place first.')
      return
    }
    setGeneratingExplorationRoute(true)
    setExplorationRouteError(null)
    try {
      const savedRoute = await generateExplorationRoute({
        destination: trip.destination,
        interests: trip.interests,
        transport: trip.transport,
        places: selected,
      })
      setActiveExplorationRoute(savedRoute)
      setSavedExplorationRoutes((current) => [savedRoute, ...current.filter((route) => route.id !== savedRoute.id)])
      setSavedExplorationRoutesExpanded(true)
      window.setTimeout(() => document.getElementById('active-exploration-route')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80)
    } catch (error) {
      setExplorationRouteError(error instanceof Error ? error.message : 'Could not generate the extra-place route.')
    } finally {
      setGeneratingExplorationRoute(false)
    }
  }

  const openExplorationRoute = (route: ExplorationRoute) => {
    setActiveExplorationRoute(route)
    setExplorationRouteError(null)
    window.setTimeout(() => document.getElementById('active-exploration-route')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
  }

  const removeExplorationRoute = async (routeId: number) => {
    setDeletingExplorationRouteId(routeId)
    setSavedExplorationRoutesError(null)
    try {
      await deleteExplorationRoute(routeId)
      setSavedExplorationRoutes((current) => current.filter((route) => route.id !== routeId))
      setActiveExplorationRoute((current) => current?.id === routeId ? null : current)
    } catch (error) {
      setSavedExplorationRoutesError(error instanceof Error ? error.message : 'Could not delete that saved exploration route.')
    } finally {
      setDeletingExplorationRouteId(null)
    }
  }

  const openSavedTrip = async (tripId: number) => {
    setOpeningTripId(tripId)
    setPlanError(null)
    try {
      const savedTrip = await getTrip(tripId)
      setTrip(savedTrip)
      setOtherPlaces([])
      setOtherPlacesLoaded(false)
      setOtherPlacesError(null)
      setSelectedOtherPlaceIds([])
      setActiveExplorationRoute(null)
      setDestination(savedTrip.destination)
      setDuration(String(savedTrip.duration))
      const savedCurrency = savedTrip.budget_currency ?? 'INR'
      setBudgetCurrency(savedCurrency)
      if (savedCurrency === 'USD' && savedTrip.budget_exchange_rate) {
        setUsdInrRate(savedTrip.budget_exchange_rate)
        setUsdInrRateSource('Saved reference rate')
      }
      setUsdInrRateDate(null)
      setBudget(String(savedTrip.budget_input_amount ?? savedTrip.budget))
      setTravelers(String(savedTrip.travelers))
      setTransport(savedTrip.transport)
      setInterests(savedTrip.interests.filter((interest) => interestOptions.includes(interest)))
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : 'That saved trip could not be opened.')
    } finally {
      setOpeningTripId(null)
    }
  }

  return (
    <main ref={appRootRef} className="relative min-h-screen overflow-hidden bg-[#071522] text-[#ECF5FC] selection:bg-[#57DCC6]/30 selection:text-white">
    <style>{`
      @page { size: A4 portrait; margin: 10mm; }
      @media print {
        html, body { background: #071522 !important; margin: 0 !important; overflow: visible !important; }
        body * { visibility: hidden !important; }
        header { display: none !important; }
        main { position: static !important; min-height: 0 !important; height: auto !important; overflow: visible !important; }
        main > section { display: none !important; }
        main > #plan-view { display: block !important; position: static !important; width: 100% !important; max-width: none !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }
        #plan-view > * { display: none !important; }
        #generated-itinerary, #active-exploration-route { display: none !important; }
        body[data-roamwise-pdf-target="itinerary"] #generated-itinerary,
        body[data-roamwise-pdf-target="itinerary"] #generated-itinerary *,
        body[data-roamwise-pdf-target="exploration"] #active-exploration-route,
        body[data-roamwise-pdf-target="exploration"] #active-exploration-route * { visibility: visible !important; }
        body[data-roamwise-pdf-target="itinerary"] #generated-itinerary,
        body[data-roamwise-pdf-target="exploration"] #active-exploration-route {
          display: block !important;
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          width: 100% !important;
          max-width: none !important;
          margin: 0 !important;
          overflow: visible !important;
          box-shadow: none !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        #generated-itinerary [data-pdf-exclude="true"],
        #active-exploration-route [data-pdf-exclude="true"],
        #generated-itinerary .pdf-hide,
        #active-exploration-route .pdf-hide { display: none !important; }
        #generated-itinerary .itinerary-days-grid { grid-template-columns: minmax(0, 1fr) !important; }
        #active-exploration-route .exploration-place-grid { grid-template-columns: minmax(0, 1fr) !important; }
        #generated-itinerary article, #active-exploration-route article {
          break-inside: avoid !important;
          page-break-inside: avoid !important;
          box-shadow: none !important;
        }
        #generated-itinerary .leaflet-container,
        #active-exploration-route .leaflet-container {
          height: 360px !important;
          min-height: 360px !important;
          max-height: none !important;
          break-inside: avoid !important;
          page-break-inside: avoid !important;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        #generated-itinerary .leaflet-control-zoom,
        #active-exploration-route .leaflet-control-zoom { display: none !important; }
        #generated-itinerary a, #active-exploration-route a { text-decoration: none !important; }
      }
    `}</style>
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
        <div
          ref={spotlightRef}
          className="absolute -left-[250px] -top-[250px] h-[500px] w-[500px] rounded-full opacity-0 blur-[1px] transition-opacity duration-700 ease-out"
          style={{
            background: 'radial-gradient(circle, rgba(87, 220, 198, 0.075) 0%, rgba(56, 189, 248, 0.035) 32%, rgba(7, 21, 34, 0) 68%)',
            willChange: 'transform, opacity',
          }}
        />
      </div>
      <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-[#071522]/90 backdrop-blur-xl">
        <nav className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <button
            type="button"
            onClick={() => navigateToView('home')}
            className="flex items-center gap-2.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#57DCC6]"
            aria-label="RoamWise home"
          >
            <span className="grid h-9 w-9 place-items-center rounded-xl border border-[#57DCC6]/30 bg-[#123C4B] text-[#75E9D5] shadow-[0_0_24px_rgba(87,220,198,0.12)]">
              <Compass size={21} />
            </span>
            <span className="text-xl font-extrabold tracking-tight text-white">roam<span className="text-[#65DCC9]">wise</span></span>
          </button>

          <div className="flex items-center gap-1 sm:gap-3">
            <button
              type="button"
              onClick={() => navigateToView('explore')}
              className={`rounded-full px-3 py-2 text-sm font-semibold transition sm:px-5 ${view === 'explore' ? 'bg-[#163649] text-[#78E7D4]' : 'text-[#C2D2DF] hover:bg-white/[0.06] hover:text-white'}`}
            >
              Explore
            </button>
            <button
              type="button"
              onClick={() => openPlanner()}
              className={`rounded-full px-3 py-2 text-sm font-semibold transition sm:px-5 ${view === 'plan' ? 'bg-[#163649] text-[#78E7D4]' : 'text-[#C2D2DF] hover:bg-white/[0.06] hover:text-white'}`}
            >
              Plan a trip
            </button>
          </div>
        </nav>
      </header>

      {view === 'home' && (
        <section
          className="relative z-10 isolate flex min-h-[calc(100svh-73px)] w-full flex-col items-center justify-center overflow-hidden px-5 py-12 sm:px-8 sm:py-16"
        >
          <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
            <div className="absolute left-1/2 top-[-7rem] h-[28rem] w-[38rem] -translate-x-1/2 rounded-full bg-cyan-500/[0.10] blur-[100px]" />
            <div className="absolute -right-28 bottom-[-5rem] h-80 w-80 rounded-full bg-blue-500/[0.12] blur-[90px]" />
          </div>

          <div className="mx-auto w-full max-w-4xl text-center">
            <span className="animate-hero-badge inline-flex items-center gap-2 rounded-full border border-[#57DCC6]/25 bg-[#0C2938]/80 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#7AE9D6] shadow-[0_0_34px_rgba(87,220,198,0.07)] sm:text-xs">
              <Sparkles size={15} /> Budget-aware travel planner
              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-[#57DCC6] shadow-[0_0_10px_#57DCC6]" />
            </span>
            <h1 className="animate-hero-headline mx-auto mt-7 w-full max-w-5xl text-center text-4xl font-extrabold leading-[1.08] tracking-[-0.045em] text-white sm:text-6xl md:text-7xl">
              Your next adventure,{' '}
              <span className="bg-gradient-to-r from-[#65E6D0] via-[#8CDDF4] to-[#AFA6FF] bg-clip-text font-serif font-medium italic text-transparent">
                planned smarter.
              </span>
            </h1>
            <p className="animate-hero-desc mx-auto mt-6 max-w-2xl text-base leading-7 text-[#B4C7D6] sm:text-lg sm:leading-8">
              Plan smarter with RoamWise: discover real places, organize your days, and keep your trip preferences together.
            </p>
            
          </div>

          <div className="mx-auto mt-10 grid w-full max-w-3xl gap-4 sm:mt-12 sm:grid-cols-2">
            <div className="animate-hero-card-1">
              <TiltCardButton
                type="button"
                onClick={() => navigateToView('explore')}
                className="flex min-h-36 w-full items-center gap-4 overflow-hidden rounded-2xl border border-[#29485C] bg-[#0C2333]/90 p-5 text-left shadow-[0_16px_50px_rgba(0,0,0,0.18)] transition duration-300 hover:border-[#57DCC6]/60 hover:bg-[#102B3D] hover:shadow-[0_18px_55px_rgba(20,184,166,0.10)] sm:p-6"
                glowBorderColor="rgba(87, 220, 198, 0.45)"
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#57DCC6]/15 bg-[#123D43] text-[#72E8D2] transition duration-300 group-hover:scale-105 group-hover:bg-[#174D52]">
                  <Search size={23} />
                </span>
                <span className="flex-1">
                  <span className="block text-lg font-bold text-white">Explore</span>
                  <span className="mt-1 block text-sm leading-5 text-[#A8BECE]">Discover destinations and find your next favourite place.</span>
                </span>
                <ArrowRight size={19} className="shrink-0 text-[#83A5B8] transition duration-300 ease-out group-hover:translate-x-1.5 group-hover:text-[#70E6D2]" />
                <span className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-cyan-400/[0.06] blur-2xl" />
              </TiltCardButton>
            </div>

            <div className="animate-hero-card-2">
              <TiltCardButton
                type="button"
                onClick={() => openPlanner()}
                className="flex min-h-36 w-full items-center gap-4 overflow-hidden rounded-2xl border border-[#347087] bg-gradient-to-br from-[#15394C] to-[#102638] p-5 text-left shadow-[0_16px_50px_rgba(0,0,0,0.22)] transition duration-300 hover:border-[#76E7D7]/70 hover:shadow-[0_18px_55px_rgba(63,192,200,0.12)] sm:p-6"
                glowBorderColor="rgba(118, 231, 215, 0.55)"
              >
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-[#72E8D2]/20 bg-[#1A4C5B] text-[#7AE9D6] transition duration-300 group-hover:scale-105 group-hover:bg-[#205C68]">
                  <Sparkles size={23} />
                </span>
                <span className="flex-1">
                <span className="flex flex-wrap items-center gap-2 text-lg font-bold text-white">Plan a trip <span className="rounded-full border border-[#73E4D2]/25 bg-[#58D9C2]/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-[#87EBDC]">Gemma + open routes</span></span>
                  <span className="mt-1 block text-sm leading-5 text-[#B6CFDD]">Build an itinerary around your budget, time and interests.</span>
                </span>
                <ArrowRight size={19} className="shrink-0 text-[#83A5B8] transition duration-300 ease-out group-hover:translate-x-1.5 group-hover:text-[#70E6D2]" />
                <span className="pointer-events-none absolute -right-8 -top-10 h-36 w-36 rounded-full bg-blue-400/[0.09] blur-3xl" />
              </TiltCardButton>
            </div>
          </div>

          <div className="animate-hero-features mx-auto mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs font-medium text-[#7592A6] sm:mt-10 sm:text-sm">
            <span className="inline-flex items-center gap-1.5"><Sparkles size={14} className="text-[#65DCC9]" /> Personalized planning</span>
            <span className="hidden h-1 w-1 rounded-full bg-[#446579] sm:block" />
            <span>Budget-aware ideas</span>
            <span className="hidden h-1 w-1 rounded-full bg-[#446579] sm:block" />
            <span>Made for your travel style</span>
          </div>
        </section>
      )}

      {view === 'explore' && (
        <section className="relative z-10 mx-auto min-h-[calc(100svh-73px)] w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#72E8D2]">Explore destinations</p>
              <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Find your somewhere.</h1>
              <p className="mt-2 text-sm text-[#A8BECE] sm:text-base">Discover a few places to spark your next trip.</p>
            </div>
            <label className="relative block w-full sm:max-w-xs">
              <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#7F9BAF]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search destinations"
                className="w-full rounded-xl border border-[#2B4A60] bg-[#0C2232] py-3 pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-[#7E98AA] focus:border-[#57DCC6] focus:ring-2 focus:ring-[#57DCC6]/15"
              />
            </label>
          </div>

          {isSearching && <p className="mt-5 text-sm text-[#8EA9BB]">Searching destination ideas…</p>}
          {exploreError && (
            <div role="status" className="mt-5 rounded-xl border border-amber-300/25 bg-amber-200/10 px-4 py-3 text-sm leading-5 text-amber-100">
              The live destination search is unavailable. Showing the built-in visual fallback instead. {exploreError}
            </div>
          )}

          {filteredDestinations.length > 0 ? (
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {filteredDestinations.map((place) => (
                <article key={place.name} className="overflow-hidden rounded-2xl border border-[#29485C] bg-[#0C2232] shadow-[0_12px_35px_rgba(0,0,0,0.16)] transition duration-200 hover:-translate-y-1 hover:border-[#57DCC6]/35 hover:shadow-xl">
                  <div className="relative overflow-hidden">
                    <img src={place.image} alt={place.name} className="h-48 w-full object-cover transition duration-500 hover:scale-105" loading="lazy" />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#061522]/85 via-transparent to-transparent" />
                    <span className="absolute bottom-3 left-4 rounded-full border border-white/15 bg-[#071522]/70 px-3 py-1 text-xs font-semibold text-[#D8F9F2] backdrop-blur">{place.tag}</span>
                  </div>
                  <div className="p-5">
                    <h2 className="text-xl font-bold text-white">{place.name}</h2>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-[#89A5B8]"><MapPin size={13} className="text-[#70E6D2]" />{place.region}</p>
                    <p className="mt-3 min-h-10 text-sm leading-5 text-[#B4C7D6]">{place.description}</p>
                    <button
                      type="button"
                      onClick={() => openPlanner(place.name)}
                      className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#57DCC6]/25 bg-[#123B45] px-4 py-2.5 text-sm font-semibold text-[#83EAD9] transition hover:border-[#57DCC6]/50 hover:bg-[#174A55]"
                    >
                      Plan this trip <ArrowRight size={15} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : !isSearching && hasLoadedExploreDestinations && successfulExploreQuery === search.trim() && !exploreError ? (
            <div className="mt-12 rounded-2xl border border-dashed border-[#35566A] bg-[#0C2232]/60 p-10 text-center text-sm text-[#A8BECE]">
              <p>No curated Explore cards match “{search}”. You can still plan any destination with Gemma's recommendations.</p>
              <button type="button" onClick={() => openPlanner(search.trim())} className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#57DCC6]/30 bg-[#123B45] px-4 py-2.5 text-sm font-semibold text-[#83EAD9] transition hover:bg-[#174A55]">
                Plan {search.trim() ? `a trip to ${search.trim()}` : 'a trip'} <ArrowRight size={15} />
              </button>
            </div>
          ) : null}
        </section>
      )}

      {view === 'plan' && (
        <section id="plan-view" className="relative z-10 mx-auto min-h-[calc(100svh-73px)] w-full max-w-6xl min-w-0 px-4 py-6 sm:px-6 sm:py-9 lg:px-8 lg:py-12">
          <button type="button" onClick={() => window.history.back()} className="inline-flex items-center gap-2 text-sm font-semibold text-[#9BB2C2] transition hover:text-[#78E7D4]">
            <ArrowLeft size={16} /> Back
          </button>
          <div className="relative isolate mt-5 overflow-hidden rounded-[28px] border border-[#29485C] bg-[#0B2433] p-5 shadow-[0_24px_75px_rgba(0,0,0,0.20)] sm:mt-6 sm:p-7 lg:p-8">
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_5%_5%,rgba(87,220,198,0.15),transparent_55%),linear-gradient(115deg,#0E2B3B_0%,#0A1D2B_68%,#0B2633_100%)]" />
            <div aria-hidden="true" className="absolute right-0 top-0 hidden h-full w-[45%] bg-cover bg-center opacity-90 lg:block" style={{ backgroundImage: "linear-gradient(90deg, #0B2433 0%, rgba(11,36,51,0.80) 28%, rgba(11,36,51,0.20) 100%), url('https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1100&q=85')" }} />
            <div className="relative z-10 max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-[#57DCC6]/25 bg-[#071B28]/60 px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#78E7D4] sm:text-xs"><Sparkles size={14} /> Your next escape starts here <span className="h-1.5 w-1.5 rounded-full bg-[#57DCC6] shadow-[0_0_10px_rgba(87,220,198,0.75)]" /></p>
              <h1 className="mt-4 max-w-2xl text-3xl font-extrabold leading-[1.08] tracking-[-0.04em] text-white sm:text-4xl lg:text-[2.8rem]">Where do you want to go?</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-[#C0D2DE] sm:text-base">Start with a place. RoamWise finds ideas around your interests, checks locations, then builds a route that makes sense.</p>
              <div className="mt-5 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[#B2CAD7] sm:text-xs">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#061A27]/50 px-3 py-1.5"><MapPin size={13} className="text-[#70E6D2]" /> Real places</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#061A27]/50 px-3 py-1.5"><Compass size={13} className="text-[#70E6D2]" /> Route-aware days</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#061A27]/50 px-3 py-1.5"><Wallet size={13} className="text-[#70E6D2]" /> Your budget</span>
              </div>
            </div>
          </div>

          <form onSubmit={generateItinerary} className="mt-4 min-w-0 rounded-[28px] border border-[#29485C] bg-gradient-to-b from-[#0D2636] to-[#091B28] p-4 shadow-[0_24px_70px_rgba(0,0,0,0.19)] sm:mt-5 sm:p-6 lg:p-7">
            <div className="mb-5 flex flex-col gap-2 border-b border-white/[0.07] pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#70E6D2]">Trip builder · Step 1</p>
                <h2 className="mt-1 text-xl font-bold tracking-tight text-white sm:text-2xl">Make it your kind of trip</h2>
              </div>
              
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-6 sm:gap-x-7 sm:gap-y-7 lg:grid-cols-2">
              <div className="min-w-0 lg:col-span-2">
                <div className="rounded-2xl border border-[#57DCC6]/35 bg-[linear-gradient(135deg,rgba(22,67,78,0.64),rgba(7,27,41,0.96)_62%)] p-4 shadow-[0_12px_35px_rgba(0,0,0,0.12)] sm:rounded-3xl sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label htmlFor="trip-destination" className="flex items-center gap-2 text-sm font-bold text-white sm:text-base"><span className="grid h-8 w-8 place-items-center rounded-xl border border-[#57DCC6]/20 bg-[#0A2A36] text-[#70E6D2]"><MapPin size={17} /></span> Destination <span className="text-[#70E6D2]">*</span></label>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#57DCC6]/20 bg-[#071B28]/65 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#88B9C6]"><span className="h-1.5 w-1.5 rounded-full bg-[#57DCC6]" /> Start here</span>
                  </div>
                <div className="relative">
                  <Search size={21} aria-hidden="true" className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-[#70E6D2]" />
                  <input
                    id="trip-destination"
                    required
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={destinationSuggestionsOpen}
                    aria-controls="planner-destination-suggestions"
                    aria-activedescendant={activeDestinationSuggestionIndex >= 0 ? `planner-destination-option-${activeDestinationSuggestionIndex}` : undefined}
                    value={destination}
                    onFocus={() => setDestinationSuggestionsOpen(true)}
                    onBlur={() => {
                      // Delay is unnecessary because list items prevent mousedown blur;
                      // the focused input can close its menu directly on blur.
                      setDestinationSuggestionsOpen(false)
                    }}
                    onChange={(event) => {
                      setDestination(event.target.value)
                      setActiveDestinationSuggestionIndex(-1)
                      clearPlanResult()
                      setDestinationSuggestionsOpen(true)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        setDestinationSuggestionsOpen(false)
                        setActiveDestinationSuggestionIndex(-1)
                      } else if (event.key === 'ArrowDown' && destinationSuggestionsOpen && destinationSuggestions.length > 0) {
                        event.preventDefault()
                        setActiveDestinationSuggestionIndex((index) => Math.min(index + 1, destinationSuggestions.length - 1))
                      } else if (event.key === 'ArrowUp' && destinationSuggestionsOpen && destinationSuggestions.length > 0) {
                        event.preventDefault()
                        setActiveDestinationSuggestionIndex((index) => Math.max(index - 1, 0))
                      } else if (event.key === 'Enter' && destinationSuggestionsOpen && (destinationSuggestionsLoading || destinationSuggestions.length > 0)) {
                        event.preventDefault()
                        if (destinationSuggestions.length > 0) {
                          const index = activeDestinationSuggestionIndex >= 0 ? activeDestinationSuggestionIndex : 0
                          selectDestinationSuggestion(destinationSuggestions[index])
                        }
                      }}}
                    placeholder="Type at least 2 letters to search cities and destinations..."
                    className={`${fieldClass} h-[62px] rounded-xl border-[#3B6F7E] bg-[#061925] pl-14 pr-4 text-base font-semibold shadow-inner shadow-black/25 placeholder:text-[#6E8A9D] focus:border-[#57DCC6] focus:ring-4 focus:ring-[#57DCC6]/10 sm:h-[70px] sm:text-lg`}
                  />
                  {destinationSuggestionsOpen && (
                    <div
                      id="planner-destination-suggestions"
                      role="listbox"
                      aria-label="Destination suggestions"
                      className="absolute left-0 right-0 top-full z-40 mt-2 max-h-72 overflow-y-auto rounded-xl border border-[#2B4A60] bg-[#0B2030] p-1.5 shadow-[0_18px_40px_rgba(0,0,0,0.4)]"
                    >
                      {destination.trim().length < 2 ? (
                        <p className="px-3 py-3 text-sm text-[#9CB5C6]">Type at least 2 characters to search destinations.</p>
                      ) : destinationSuggestionsLoading ? (
                        <p className="flex items-center gap-2 px-3 py-3 text-sm text-[#9CB5C6]"><span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#70E6D2] border-r-transparent" /> Searching real destinations…</p>
                      ) : destinationSuggestionsError ? (
                        <div className="px-3 py-3 text-sm text-[#F2B9C1]">
                          <p>{destinationSuggestionsError}</p>
                          <p className="mt-1 text-xs text-[#9CB5C6]">You can still type a full destination name and generate a plan.</p>
                        </div>
                      ) : destinationSuggestions.length > 0 ? (
                        destinationSuggestions.map((suggestion, index) => (
                          <button
                            key={`${suggestion.label}-${suggestion.result_type}`}
                            id={`planner-destination-option-${index}`}
                            type="button"
                            role="option"
                            aria-selected={activeDestinationSuggestionIndex === index}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setActiveDestinationSuggestionIndex(index)}
                            onClick={() => selectDestinationSuggestion(suggestion)}
                            className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition ${activeDestinationSuggestionIndex === index ? 'bg-[#15394C] text-[#78E7D4]' : 'text-[#D9E7F1] hover:bg-[#15394C] hover:text-[#78E7D4]'}`}
                          >
                            <MapPin size={15} className="mt-0.5 shrink-0 text-[#70E6D2]" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold">{suggestion.title}</span>
                              {suggestion.label && suggestion.label !== suggestion.title && <span className="mt-0.5 block truncate text-xs text-[#9CB5C6]">{suggestion.label}</span>}
                            </span>
                            <span className="mt-0.5 shrink-0 rounded-md border border-[#2B4A60] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#9CB5C6]">{suggestion.result_type.replace(/_/g, ' ')}</span>
                          </button>
                        ))
                      ) : (
                        <p className="px-3 py-3 text-sm text-[#9CB5C6]">No matching destinations found. Try adding a state or country, e.g. “Tokyo, Japan”.</p>
                      )}
                    </div>
                  )}
                </div>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] leading-5 text-[#86A5B7] sm:text-xs">
                    <span>Search a city, town, region or nearby area.</span>
                    <span className="inline-flex items-center gap-1.5 text-[#78CFC2]"><Search size={12} /> Smart destination suggestions</span>
                  </div>
                </div>
              </div>

              <label className={`${fieldLabelClass} min-w-0 lg:col-start-1 lg:row-start-2`}>
                <span className="mb-2 flex items-center gap-2"><CalendarDays size={16} className="text-[#70E6D2]" /> Duration</span>
                <select value={duration} onChange={(event) => { setDuration(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => <option key={day} value={String(day)}>{day} {day === 1 ? 'day' : 'days'}</option>)}
                </select>
              </label>

              <label className={`${fieldLabelClass} min-w-0 lg:col-start-2 lg:row-start-2`}>
                <span className="mb-2 flex items-center gap-2"><Users size={16} className="text-[#70E6D2]" /> Travelers</span>
                <select value={travelers} onChange={(event) => { setTravelers(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={String(count)}>{count} {count === 1 ? 'traveler' : 'travelers'}</option>)}
                </select>
              </label>

              <div className={`${fieldLabelClass} min-w-0 lg:col-start-1 lg:row-start-3`}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                  <label htmlFor="trip-budget" className="flex items-center gap-2"><Wallet size={16} className="text-[#70E6D2]" /> Total budget</label>
                  <div role="group" aria-label="Budget currency" className="inline-flex rounded-xl border border-[#2B4A60] bg-[#061724] p-1">
                    <button type="button" onClick={() => void changeBudgetCurrency('INR')} disabled={currencyRateLoading} aria-pressed={budgetCurrency === 'INR'} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${budgetCurrency === 'INR' ? 'bg-[#174653] text-[#8AECDD]' : 'text-[#9CB5C6] hover:text-white'}`}>₹ INR</button>
                    <button type="button" onClick={() => void changeBudgetCurrency('USD')} disabled={currencyRateLoading} aria-pressed={budgetCurrency === 'USD'} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${budgetCurrency === 'USD' ? 'bg-[#174653] text-[#8AECDD]' : 'text-[#9CB5C6] hover:text-white'}`}>$ USD</button>
                  </div>
                </div>
                <div className="mt-2 grid min-w-0 gap-4 rounded-2xl border border-[#2B4A60] bg-[#071B28]/45 p-3 sm:p-4 md:grid-cols-[minmax(130px,0.38fr)_minmax(0,1fr)] md:items-center md:gap-6">
                  <input
                    id="trip-budget"
                    required
                    type="number"
                    min={budgetMin}
                    max={budgetMax}
                    step={budgetCurrency === 'USD' ? '0.01' : '1'}
                    value={budget}
                    onChange={(event) => { setBudget(event.target.value); clearPlanResult() }}
                    className={`${fieldClass} h-12 text-lg font-extrabold tabular-nums`}
                  />
                  <div className="min-w-0 px-1 py-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
                      <span className="text-[#8EA9BB]">Adjust your budget</span>
                      <span className="font-bold tabular-nums text-[#78E7D4]">{formatBudgetCurrency(Number(budget || 0), budgetCurrency)}</span>
                    </div>
                    <input
                      aria-label="Adjust total trip budget"
                      type="range"
                      min={budgetMin}
                      max={budgetMax}
                      step={budgetCurrency === 'USD' ? '1' : '100'}
                      value={Math.min(budgetMax, Math.max(budgetMin, Number(budget) || budgetMin))}
                      onChange={(event) => { setBudget(event.target.value); clearPlanResult() }}
                      className="mt-3 w-full cursor-pointer accent-[#57DCC6]"
                    />
                    <div className="flex justify-between gap-4 text-[10px] font-medium text-[#7894A7]">
                      <span>{formatBudgetCurrency(budgetMin, budgetCurrency)}</span>
                      <span>{formatBudgetCurrency(budgetMax, budgetCurrency)}</span>
                    </div>
                  </div>
                </div>
                {currencyRateLoading && <p className="mt-2 text-xs text-[#8EA9BB]">Loading daily USD/INR reference rate…</p>}
                {currencyRateError && <p role="alert" className="mt-2 text-xs text-rose-200">{currencyRateError}</p>}
                {budgetCurrency === 'USD' && usdInrRate && <p className="mt-2 text-xs leading-5 text-[#819BAD]">Reference rate: $1 ≈ {formatINR(usdInrRate)} INR{usdInrRateDate ? ` · ${usdInrRateDate}` : ''}. {usdInrRateSource?.toLowerCase().includes('exchange') ? <a href="https://www.exchangerate-api.com/docs/free" target="_blank" rel="noreferrer" className="text-[#78E7D4] underline underline-offset-2">ExchangeRate-API source</a> : usdInrRateSource ? `Source: ${usdInrRateSource}.` : null} Currency conversion applies only to your entered planning budget; no trip-cost estimate is generated.</p>}
              </div>

              <label className={`${fieldLabelClass} min-w-0 lg:col-start-2 lg:row-start-3`}>
                <span className="mb-2 flex items-center gap-2"><Compass size={16} className="text-[#70E6D2]" /> Transportation preference</span>
                <select value={transport} onChange={(event) => { setTransport(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {['Flexible', 'Public transport', 'Walking', 'Cab', 'Rental vehicle'].map((option) => <option key={option}>{option}</option>)}
                </select>
              </label>
            </div>

            <fieldset className="mt-6 overflow-hidden rounded-2xl border border-[#29485C] bg-[#071B28]/55 p-4 sm:mt-7 sm:rounded-3xl sm:p-5">
              <legend className="sr-only">What are you interested in?</legend>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-[#70E6D2]">Step 2 · Your vibe</p>
                  <h3 className="mt-1 text-lg font-bold tracking-tight text-white sm:text-xl">What sounds like your kind of adventure?</h3>
                  
                </div>
                <div className="flex shrink-0 items-center gap-2 self-start">
                  <span className="rounded-full border border-[#2B4A60] bg-[#091E2C] px-2.5 py-1.5 text-[10px] font-bold text-[#9CB6C6]">{interests.length} selected</span>
                  <button
                    type="button"
                    onClick={toggleAllInterests}
                    aria-pressed={allInterestsSelected}
                    className="rounded-full border border-[#57DCC6]/35 bg-[#0D2A37] px-3.5 py-2 text-xs font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#123D43]"
                  >
                    {allInterestsSelected ? 'Clear all' : 'Select all'}
                  </button>
                </div>
              </div>
              
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                {interestOptions.map((interest) => {
                  const selected = interests.includes(interest)
                  const emoji: Record<string, string> = {
                    Nature: '🌿',
                    History: '🏛️',
                    'Local food': '🍜',
                    Adventure: '🧭',
                    Photography: '📷',
                    'Popular / hot': '🔥',
                  }
                  const isPopular = interest === 'Popular / hot'
                  return (
                    <button
                      key={interest}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => { toggleInterest(interest); clearPlanResult() }}
                      className={`group flex min-h-[76px] min-w-0 flex-col items-start justify-between gap-2 rounded-xl border p-3 text-left transition duration-200 sm:min-h-[84px] sm:p-3.5 ${selected ? (isPopular ? 'border-amber-300/45 bg-[linear-gradient(145deg,rgba(111,75,28,0.26),rgba(10,32,45,0.94))] text-[#FFE2A8] shadow-[inset_0_1px_rgba(255,255,255,0.04)]' : 'border-[#57DCC6]/45 bg-[linear-gradient(145deg,rgba(22,67,78,0.64),rgba(8,29,42,0.96))] text-[#A4F2E5] shadow-[inset_0_1px_rgba(255,255,255,0.05)]') : 'border-[#29485C] bg-[#091E2C] text-[#AFC4D3] hover:border-[#57DCC6]/40 hover:bg-[#0D2938] hover:text-white'}`}
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="text-lg leading-none sm:text-xl">{emoji[interest]}</span>
                        {selected && <Check size={14} className="shrink-0 text-current" aria-hidden="true" />}
                      </span>
                      <span className="break-words text-xs font-semibold leading-4 sm:text-sm">{interest}</span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            {planError && (
              <div role="alert" className="mt-6 rounded-xl border border-rose-300/30 bg-rose-400/10 px-4 py-3 text-sm leading-5 text-rose-100">
                {planError}
              </div>
            )}
            <div className="mt-6 flex flex-col items-stretch gap-3 sm:mt-7 sm:flex-row sm:flex-wrap sm:items-center">
              <button disabled={isGenerating} type="submit" className="inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#38D3B9] via-[#3BC7C4] to-[#5EBDEB] px-6 py-3.5 font-extrabold text-[#041923] shadow-[0_12px_30px_rgba(37,188,165,0.20)] transition hover:-translate-y-0.5 hover:brightness-110 disabled:translate-y-0 disabled:cursor-wait disabled:opacity-80 sm:w-auto sm:min-w-[230px]">
                {isGenerating ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
                {isGenerating ? 'Generating, this will take a few minutes' : 'Generate itinerary'}
                {!isGenerating && <ArrowRight size={17} aria-hidden="true" />}
              </button>
              {isGenerating && (
                <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-xs leading-5 text-[#9EB7C7]">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#57DCC6]" aria-hidden="true" />
                  Finding places and optimizing your route. You can keep using RoamWise.
                </p>
              )}
            </div>
           
          </form>

          {trip && (
            <section id="generated-itinerary" aria-live="polite" className="mt-6 overflow-hidden rounded-3xl border border-[#2B5967] bg-[#0A202D] shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
              <div className="p-5 sm:p-7">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div>
                    <p className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]"><Sparkles size={14} /> Your journey at a glance · itinerary #{trip.id}</p>
                    <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{trip.destination} · {trip.duration} {trip.duration === 1 ? 'day' : 'days'}</h2>
                    <p className="mt-2 text-sm text-[#B4C7D6]">{trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'} <span className="mx-1 text-[#55778A]">·</span> {trip.transport} <span className="mx-1 text-[#55778A]">·</span> {formatBudgetCurrency(trip.budget_input_amount ?? trip.budget, trip.budget_currency ?? 'INR')} group budget{trip.budget_currency === 'USD' ? ` (≈ ${formatINR(trip.budget)})` : ''}</p>
                  </div>
                  <button type="button" onClick={() => void downloadResultPdf('itinerary')} disabled={pdfPreparing !== null} className="pdf-hide inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-xl border border-[#57DCC6]/40 bg-[#123B45] px-4 py-2.5 text-sm font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#174A55] disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#57DCC6]">
                    <Download size={16} aria-hidden="true" />
                    {pdfPreparing === 'itinerary' ? 'Preparing PDF…' : 'Download PDF'}
                  </button>
                </div>

                <div className="mt-6 overflow-hidden rounded-2xl border border-[#29485C] bg-[#081B28]">
                  <div className="flex flex-col justify-between gap-2 border-b border-[#29485C] px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                    <div>
                      <h3 className="font-bold text-white">Your route</h3>
                      <p className="mt-1 text-xs leading-5 text-[#8FAABD]">Stops are labelled by day. Select a pin to see details.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {trip.itinerary.map((day, index) => (
                        <span key={day.day} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-bold text-[#DCEAF3]">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ['#57DCC6', '#AFA6FF', '#F5C36B', '#8DCBFF', '#FF9CBA', '#B2E58D', '#F3A67E'][index % 7] }} />
                          DAY {day.day}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ItineraryMap destination={trip.destination} itinerary={trip.itinerary} />
                  
                </div>

                <section data-pdf-exclude="true" className="mt-7 overflow-hidden rounded-2xl border border-[#2B5967] bg-gradient-to-br from-[#0D2938] to-[#081B28]" aria-labelledby="other-places-title">
                  <div className="border-b border-[#29485C] p-4 sm:p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="inline-flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]"><Trees size={14} /> Optional add-on · 100 km radius</p>
                        <h3 id="other-places-title" className="mt-1 text-xl font-extrabold text-white sm:text-2xl">Other places to explore</h3>
                        
                        
                      </div>
                      <button type="button" onClick={() => void discoverOtherPlaces()} disabled={otherPlacesLoading} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[#57DCC6]/35 bg-[#123B45] px-4 py-2.5 text-sm font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#174A55] disabled:cursor-wait disabled:opacity-65">
                        {otherPlacesLoading ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
                        {otherPlacesLoading ? 'Finding nearby places…' : otherPlacesLoaded ? 'Refresh places' : 'Find places nearby'}
                      </button>
                    </div>
                  </div>

                  <div className="p-4 sm:p-5">
                    {otherPlacesLoading && <div role="status" className="flex items-center gap-3 rounded-xl border border-[#29485C] bg-[#071A27] p-4 text-sm text-[#AFC4D3]"><LoaderCircle size={18} className="animate-spin text-[#78E7D4]" /> Gemma is finding additional places and verifying coordinates within 100 km. You can keep using the page.</div>}
                    {otherPlacesError && <p role="status" className="mt-3 rounded-xl border border-amber-200/20 bg-amber-100/5 px-3 py-2.5 text-sm leading-5 text-amber-100">{otherPlacesError}</p>}

                    {otherPlaces.length > 0 && (
                      <>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-[#9DB6C6]">{otherPlaces.length} mapped options · select up to 8 for one optimized route</p>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => setSelectedOtherPlaceIds(otherPlaces.slice(0, 8).map((place) => place.id))} className="rounded-full border border-[#29485C] px-3 py-1.5 text-[11px] font-bold text-[#B4C7D6] transition hover:border-[#57DCC6]/45 hover:text-white">Select first 8</button>
                            <button type="button" onClick={() => setSelectedOtherPlaceIds([])} className="rounded-full border border-[#29485C] px-3 py-1.5 text-[11px] font-bold text-[#B4C7D6] transition hover:border-[#57DCC6]/45 hover:text-white">Clear selection</button>
                          </div>
                        </div>
                        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {otherPlaces.map((place) => {
                            const selected = selectedOtherPlaceIds.includes(place.id)
                            const isWildlife = /wildlife|sanctuary|national park|nature reserve|debrigarh|bird sanctuary/i.test(`${place.name} ${place.category}`)
                            return (
                              <label key={place.id} className={`flex min-w-0 cursor-pointer gap-3 rounded-2xl border p-4 transition ${selected ? 'border-[#57DCC6]/65 bg-[#123B43]/70 shadow-[0_0_0_1px_rgba(87,220,198,0.10)]' : 'border-[#29485C] bg-[#081B28] hover:border-[#57DCC6]/35 hover:bg-[#0C2533]'}`}>
                                <input type="checkbox" checked={selected} onChange={() => toggleOtherPlace(place.id)} disabled={!selected && selectedOtherPlaceIds.length >= 8} className="mt-1 h-4 w-4 shrink-0 accent-[#57DCC6]" />
                                <span className="min-w-0 flex-1">
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="break-words text-sm font-extrabold leading-5 text-white">{place.name}</span>
                                    {isWildlife && <span className="rounded-full border border-emerald-300/25 bg-emerald-300/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-100">Wildlife & nature</span>}
                                  </span>
                                  <span className="mt-1 block text-[11px] font-semibold text-[#78E7D4]">{place.category} <span className="mx-1 text-[#4E7185]">·</span> {place.distance_from_destination_km.toFixed(1)} km away</span>
                                  <span className="mt-2 block text-xs leading-5 text-[#AFC4D3]">{place.recommendation_reason || place.description}</span>
                                  {place.address && <span className="mt-2 block text-[10px] leading-4 text-[#7896A9]">{place.address}</span>}
                                  {place.maps_url && <a href={place.maps_url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} className="mt-2 inline-flex text-[11px] font-bold text-[#78E7D4] hover:underline">Check map listing ↗</a>}
                                </span>
                              </label>
                            )
                          })}
                        </div>
                        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-[#29485C] bg-[#071A27] p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-bold text-white">{selectedOtherPlaceIds.length} place{selectedOtherPlaceIds.length === 1 ? '' : 's'} selected</p>
                            <p className="mt-1 text-xs leading-5 text-[#819BAD]">We’ll start at the destination center and optimize the order of your selected stops using the existing route optimizer.</p>
                          </div>
                          <button type="button" onClick={() => void createExplorationRoute()} disabled={generatingExplorationRoute || selectedOtherPlaceIds.length === 0} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#38D3B9] to-[#5EBDEB] px-5 py-3 text-sm font-extrabold text-[#041923] shadow-[0_10px_25px_rgba(37,188,165,0.16)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45">
                            {generatingExplorationRoute ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Route size={16} aria-hidden="true" />}
                            {generatingExplorationRoute ? 'Optimizing route…' : 'Generate optimized route'}
                          </button>
                        </div>
                        {explorationRouteError && <p role="status" className="mt-3 rounded-xl border border-amber-200/20 bg-amber-100/5 px-3 py-2.5 text-sm leading-5 text-amber-100">{explorationRouteError}</p>}
                      </>
                    )}
                    {!otherPlacesLoading && !otherPlacesLoaded && !otherPlacesError && <p className="rounded-xl border border-dashed border-[#29485C] bg-[#081B28]/75 p-4 text-sm leading-6 text-[#9BB3C3]">Find additional places around {trip.destination}. We’ll include wildlife sanctuaries and nature reserves within range when they can be verified, such as Debrigarh Wildlife Sanctuary near Hirakud.</p>}
                  </div>
                </section>

                <div className="mt-7 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]">Your day-by-day plan</p>
                    <h3 className="mt-1 text-xl font-bold text-white">Explore at your own pace</h3>
                  </div>
                  <span className="hidden rounded-full border border-[#29485C] px-3 py-1.5 text-xs text-[#A8BECE] sm:inline-flex">{trip.itinerary.reduce((sum, day) => sum + day.activities.length, 0)} planned stops</span>
                </div>

                <div className="itinerary-days-grid mt-4 grid gap-4 lg:grid-cols-2">
                  {trip.itinerary.map((day, dayIndex) => (
                    <article key={day.day} className="group rounded-2xl border border-[#29485C] bg-[#0B1C29] p-5 transition duration-200 hover:border-[#57DCC6]/40 hover:bg-[#0D2331] sm:p-6">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="grid h-10 w-10 place-items-center rounded-xl text-sm font-extrabold text-[#071522]" style={{ backgroundColor: ['#57DCC6', '#AFA6FF', '#F5C36B', '#8DCBFF', '#FF9CBA', '#B2E58D', '#F3A67E'][dayIndex % 7] }}>{String(day.day).padStart(2, '0')}</span>
                          <div>
                            <h4 className="font-bold text-white">Day {day.day}</h4>
                            {day.theme && <p className="mt-0.5 text-xs text-[#78E7D4]">{day.theme}</p>}
                            <p className="mt-0.5 text-xs text-[#87A5B8]">{day.activities.length} {day.activities.length === 1 ? 'stop planned' : 'stops planned'}</p>
                          </div>
                        </div>
                        <span className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#8FAABD]">DAY {day.day}</span>
                      </div>
                      {day.activities.length > 0 ? (
                        <div className="mt-5 space-y-4">
                          {day.activities.map((activity, activityIndex) => (
                            <div key={activity.attraction_id} className="relative pl-8">
                              {activityIndex < day.activities.length - 1 && <span className="absolute bottom-[-17px] left-[10px] top-7 w-px bg-gradient-to-b from-[#57DCC6]/70 to-[#29485C]" aria-hidden="true" />}
                              <span className="absolute left-0 top-0.5 grid h-[22px] w-[22px] place-items-center rounded-full border border-[#57DCC6]/40 bg-[#123B45] text-[10px] font-extrabold text-[#8AECDD]">{activityIndex + 1}</span>
                              <h5 className="font-bold leading-6 text-white">{activity.name}</h5>
                              <p className="mt-1 text-sm leading-6 text-[#AFC4D3]">{activity.description}</p>
                              {activity.address && <p className="mt-1 text-xs leading-5 text-[#819BAD]">{activity.address}</p>}
                              {activity.maps_url && <a href={activity.maps_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-xs font-semibold text-[#78E7D4] hover:underline">View place on OpenStreetMap ↗</a>}
                              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#8EA9BB]">
                                <span>{activity.visit_duration_minutes} min</span>
                                <span className="h-1 w-1 rounded-full bg-[#4A6B7F]" />
                                <span>{activity.entry_fee_known ? `${formatINR(activity.estimated_entry_fee_per_person)} entry/person` : 'Entry fee not verified'}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : <p className="mt-4 rounded-xl border border-dashed border-[#29485C] p-4 text-sm leading-6 text-[#AFC4D3]">{day.note}</p>}
                    </article>
                  ))}
                </div>

                {trip.interests.length > 0 && (
                  <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-[#B4C7D6]">
                    <strong className="mr-1 text-white">Your interests</strong>
                    {trip.interests.map((interest) => <span key={interest} className="rounded-full border border-[#29485C] bg-[#081B28] px-3 py-1.5 text-xs text-[#AFC4D3]">{interest}</span>)}
                  </div>
                )}
              </div>
            </section>
          )}

          {activeExplorationRoute && (
            <section id="active-exploration-route" className="mt-5 overflow-hidden rounded-3xl border border-[#2B5967] bg-[#0A202D] shadow-[0_22px_70px_rgba(0,0,0,0.18)]" aria-live="polite">
              <div className="flex flex-col justify-between gap-3 border-b border-[#29485C] p-4 sm:flex-row sm:items-start sm:p-6">
                <div className="min-w-0">
                  <p className="inline-flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]"><Route size={14} /> Separately saved exploration route · #{activeExplorationRoute.id}</p>
                  <h2 className="mt-2 text-xl font-extrabold text-white sm:text-2xl">{activeExplorationRoute.title || `Extra places near ${activeExplorationRoute.destination}`}</h2>
                  <p className="mt-2 text-sm leading-6 text-[#AFC4D3]">{activeExplorationRoute.places.length} selected stops · starts at the destination center · the main itinerary is unchanged.</p>
                </div>
                <div className="pdf-hide flex shrink-0 flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void downloadResultPdf('exploration')} disabled={pdfPreparing !== null} className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#57DCC6]/40 bg-[#123B45] px-3 py-2 text-xs font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#174A55] disabled:cursor-wait disabled:opacity-60">
                    <Download size={15} aria-hidden="true" />
                    {pdfPreparing === 'exploration' ? 'Preparing PDF…' : 'Download PDF'}
                  </button>
                  <button type="button" onClick={() => setActiveExplorationRoute(null)} className="rounded-full border border-[#29485C] px-3 py-2 text-xs font-semibold text-[#B4C7D6] transition hover:border-[#57DCC6]/45 hover:text-white">Close route preview</button>
                </div>
              </div>
              <div className="px-4 pt-4 sm:px-6">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-[#29485C] bg-[#081B28] px-3 py-1.5 text-xs text-[#B4C7D6]">{Math.round(activeExplorationRoute.travel_minutes_estimate || 0)} min travel estimate</span>
                  <span className="rounded-full border border-[#29485C] bg-[#081B28] px-3 py-1.5 text-xs text-[#B4C7D6]">{Number(activeExplorationRoute.travel_distance_km_estimate || 0).toFixed(1)} km route estimate</span>
                  <span className="rounded-full border border-[#29485C] bg-[#081B28] px-3 py-1.5 text-xs text-[#B4C7D6]">100 km discovery radius</span>
                </div>
              </div>
              <div className="m-4 overflow-hidden rounded-2xl border border-[#29485C] bg-[#081B28] sm:m-6">
                <div className="border-b border-[#29485C] px-4 py-3">
                  <h3 className="text-sm font-bold text-white">Optimized extra-place path</h3>
                  <p className="mt-1 text-xs leading-5 text-[#8FAABD]">The original route above is preserved; this is a separate optional route.</p>
                </div>
                <ItineraryMap destination={activeExplorationRoute.destination} itinerary={[{
                  day: 1,
                  theme: 'Other places to explore',
                  activities: activeExplorationRoute.places,
                  route_path: activeExplorationRoute.route_path,
                  route_path_source: activeExplorationRoute.route_path_source,
                  route_time_source: activeExplorationRoute.route_time_source,
                  travel_minutes_estimate: activeExplorationRoute.travel_minutes_estimate,
                  travel_distance_km_estimate: activeExplorationRoute.travel_distance_km_estimate,
                }]} />
                <p className="border-t border-[#29485C] px-4 py-3 text-[11px] leading-5 text-[#7898AC]">{activeExplorationRoute.route_path_source}. Route duration and distances are estimates, not live navigation. Map tiles © OpenStreetMap contributors.</p>
              </div>
              <div className="exploration-place-grid grid gap-3 p-4 pt-0 sm:grid-cols-2 sm:p-6 sm:pt-0 lg:grid-cols-3">
                {activeExplorationRoute.places.map((place, index) => (
                  <article key={`${activeExplorationRoute.id}-${place.place_id || place.attraction_id}-${index}`} className="rounded-xl border border-[#29485C] bg-[#081B28] p-4">
                    <div className="flex items-start gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#57DCC6] text-xs font-extrabold text-[#061923]">{String(index + 1).padStart(2, '0')}</span>
                      <div className="min-w-0">
                        <h3 className="break-words text-sm font-extrabold leading-5 text-white">{place.name}</h3>
                        <p className="mt-1 text-[11px] font-semibold text-[#78E7D4]">{place.category}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-[#AFC4D3]">{place.description}</p>
                    {place.address && <p className="mt-2 text-[10px] leading-4 text-[#7896A9]">{place.address}</p>}
                    {place.maps_url && <a href={place.maps_url} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-[11px] font-bold text-[#78E7D4] hover:underline">Open map listing ↗</a>}
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className="mt-5 min-w-0 overflow-hidden rounded-2xl border border-[#29485C] bg-[#0B2030] p-4 sm:mt-6 sm:p-5 lg:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#78E7D4]">Saved exploration routes</p>
                  <span className="rounded-full border border-[#2B4A60] bg-[#091E2C] px-2 py-0.5 text-[10px] font-bold text-[#9CB6C6]">{savedExplorationRoutes.length} saved</span>
                </div>
                <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Your extra routes, kept separately</h2>
                
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button type="button" onClick={() => void loadSavedExplorationRoutes()} className="inline-flex items-center justify-center rounded-full border border-[#2B4A60] px-3 py-2 text-xs font-semibold text-[#B4C7D6] transition hover:border-[#57DCC6]/50 hover:text-white">Refresh</button>
                <button type="button" onClick={() => setSavedExplorationRoutesExpanded((expanded) => !expanded)} aria-expanded={savedExplorationRoutesExpanded} aria-controls="saved-exploration-routes-panel" className="inline-flex items-center justify-center gap-2 rounded-full border border-[#57DCC6]/35 bg-[#0D2A37] px-3.5 py-2 text-xs font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#123D43]">
                  {savedExplorationRoutesExpanded ? 'Minimize' : 'Show saved routes'}
                  {savedExplorationRoutesExpanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>
            <div id="saved-exploration-routes-panel" hidden={!savedExplorationRoutesExpanded}>
              {savedExplorationRoutesError && <p role="status" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-200/5 px-3 py-2 text-sm text-amber-100">{savedExplorationRoutesError}</p>}
              {savedExplorationRoutes.length > 0 ? (
                <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
                  {savedExplorationRoutes.map((route) => (
                    <div key={route.id} className="flex min-w-0 items-start gap-3 rounded-xl border border-[#2B4A60] bg-[#091E2C] p-4">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[#57DCC6]/20 bg-[#123D43] text-[#78E7D4]"><Route size={18} /></span>
                      <div className="min-w-0 flex-1">
                        <button type="button" onClick={() => openExplorationRoute(route)} className="block w-full break-words text-left text-sm font-extrabold leading-5 text-white hover:text-[#8AECDD]">{route.title || `Explore near ${route.destination}`}</button>
                        <p className="mt-1 text-xs text-[#8EA9BB]">{route.places.length} stops · {Number(route.travel_distance_km_estimate || 0).toFixed(1)} km estimated</p>
                        <p className="mt-1 text-[10px] text-[#6F91A5]">Saved {route.created_at ? new Date(route.created_at).toLocaleDateString() : 'previously'}</p>
                        <button type="button" onClick={() => openExplorationRoute(route)} className="mt-2 text-xs font-bold text-[#78E7D4] hover:underline">Open route preview ↗</button>
                      </div>
                      <button type="button" onClick={() => void removeExplorationRoute(route.id)} disabled={deletingExplorationRouteId === route.id} title="Delete saved exploration route" aria-label={`Delete ${route.title}`} className="rounded-lg border border-[#29485C] p-2 text-[#93AFC0] transition hover:border-rose-300/35 hover:text-rose-200 disabled:opacity-50">
                        {deletingExplorationRouteId === route.id ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  ))}
                </div>
              ) : !savedExplorationRoutesError && <p className="mt-4 text-sm text-[#8EA9BB]">Generate an optimized extra-place route and it will be saved here, separately from your itinerary.</p>}
            </div>
          </section>

          <section className="mt-5 min-w-0 overflow-hidden rounded-2xl border border-[#29485C] bg-[#0B2030] p-4 sm:mt-6 sm:p-5 lg:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#78E7D4]">Saved trips</p>
                  <span className="rounded-full border border-[#2B4A60] bg-[#091E2C] px-2 py-0.5 text-[10px] font-bold text-[#9CB6C6]">{savedTrips.length} {savedTrips.length === 1 ? 'plan' : 'plans'}</span>
                </div>
                <h2 className="mt-1 text-lg font-bold text-white sm:text-xl">Reopen a previous plan</h2>
                
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button type="button" onClick={() => void loadSavedTrips()} className="inline-flex items-center justify-center rounded-full border border-[#2B4A60] px-3 py-2 text-xs font-semibold text-[#B4C7D6] transition hover:border-[#57DCC6]/50 hover:text-white">Refresh</button>
                <button
                  type="button"
                  onClick={() => setSavedTripsExpanded((expanded) => !expanded)}
                  aria-expanded={savedTripsExpanded}
                  aria-controls="saved-trips-panel"
                  className="inline-flex items-center justify-center gap-2 rounded-full border border-[#57DCC6]/35 bg-[#0D2A37] px-3.5 py-2 text-xs font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#123D43]"
                >
                  {savedTripsExpanded ? 'Minimize' : 'Show saved trips'}
                  {savedTripsExpanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                </button>
              </div>
            </div>

            <div id="saved-trips-panel" hidden={!savedTripsExpanded}>
              {savedTripsError && <p role="status" className="mt-4 rounded-xl border border-amber-300/20 bg-amber-200/5 px-3 py-2 text-sm text-amber-100">{savedTripsError}</p>}
              {savedTrips.length > 0 ? (
                <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
                  {savedTrips.map((savedTrip) => (
                    <button key={savedTrip.id} type="button" disabled={openingTripId === savedTrip.id} onClick={() => void openSavedTrip(savedTrip.id)} className="min-w-0 w-full rounded-xl border border-[#2B4A60] bg-[#091E2C] p-4 text-left transition hover:border-[#57DCC6]/45 disabled:opacity-60">
                      <span className="block break-words text-sm font-bold leading-5 text-white">{savedTrip.destination} · {savedTrip.duration} {savedTrip.duration === 1 ? 'day' : 'days'}</span>
                      <span className="mt-1 block text-xs text-[#8EA9BB]">Plan #{savedTrip.id} · {savedTrip.travelers} {savedTrip.travelers === 1 ? 'traveler' : 'travelers'} · {savedTrip.transport}</span>
                      <span className="mt-2 block text-xs font-semibold text-[#70E6D2]">{openingTripId === savedTrip.id ? 'Opening…' : 'Open saved plan'}</span>
                    </button>
                  ))}
                </div>
              ) : !savedTripsError && <p className="mt-4 text-sm text-[#8EA9BB]">Generate a plan to save it here.</p>}
            </div>
          </section>
        </section>
      )}
    </main>
  )
}
