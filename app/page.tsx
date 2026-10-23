'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ButtonHTMLAttributes, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Compass,
  MapPin,
  LoaderCircle,
  Search,
  Sparkles,
  Users,
  Wallet,
} from 'lucide-react'
import type { LatLngTuple, Map as LeafletMap } from 'leaflet'

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

type ItineraryDay = { day: number; activities: Activity[]; note?: string; theme?: string; route_path?: Array<{ latitude: number; longitude: number }>; travel_minutes_estimate?: number; travel_distance_km_estimate?: number; route_time_source?: string }

type BudgetBreakdown = {
  currency: 'INR'
  transportation: number
  accommodation: number
  food: number
  entry_fees: number
  miscellaneous: number
  total: number
  submitted_budget: number
  remaining: number
  amount_over_budget: number
  is_within_budget: boolean
  costs_are_estimates: boolean
  estimate_note: string
}

type Trip = {
  id: number
  destination: string
  duration: number
  budget: number
  travelers: number
  transport: string
  interests: string[]
  itinerary: ItineraryDay[]
  budget_breakdown: BudgetBreakdown
  is_within_budget: boolean
  costs_are_estimates: boolean
  planner_engine: string
  created_at: string
}

type PlanRequest = {
  destination: string
  duration: number
  budget: number
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

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:5000/api').replace(/\/$/, '')

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('RoamWise could not reach the Flask backend. Start it and try again.', 0)
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

async function getTrip(id: number): Promise<Trip> {
  const result = await apiRequest<{ trip: Trip }>(`/trips/${id}`)
  return result.trip
}

async function getSavedTrips(): Promise<Trip[]> {
  const result = await apiRequest<{ trips: Trip[] }>('/trips?limit=10')
  return result.trips
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
        map = L.map(mapElementRef.current, { scrollWheelZoom: false, zoomControl: true, preferCanvas: true })
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
        if (stops.length === 1) map.setView(stops[0].position, 13, { animate: false })
        else if (bounds.isValid()) map.fitBounds(bounds, { padding: [38, 38], maxZoom: 13, animate: false })
        window.setTimeout(() => { if (!cancelled) map?.invalidateSize() }, 150)

        const byDay = new Map<number, MapStop[]>()
        for (const stop of stops) byDay.set(stop.day, [...(byDay.get(stop.day) ?? []), stop])
        let routesLoaded = 0
        let failures = 0
        for (const [day, dayStops] of byDay) {
          if (cancelled) return
          if (dayStops.length < 2) continue

          // Prefer the path already calculated by the Flask/OSRM backend. If it is
          // unavailable, preserve the previously working browser-side OSRM fallback.
          const backendPath = itinerary.find((item) => item.day === day)?.route_path ?? []
          const backendLatLngs = backendPath
            .map((point) => [Number(point.latitude), Number(point.longitude)] as LatLngTuple)
            .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
          if (backendLatLngs.length >= 2 && map) {
            L.polyline(backendLatLngs, { color: MAP_DAY_COLORS[(day - 1) % MAP_DAY_COLORS.length], weight: 5, opacity: 0.92, lineCap: 'round', lineJoin: 'round' }).addTo(map)
            routesLoaded += 1
            continue
          }

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
              routesLoaded += 1
            }
          } catch {
            failures += 1
          }
        }
        if (!cancelled) setRouteStatus(routesLoaded === 0 ? 'unavailable' : failures > 0 ? 'partial' : 'ready')
      } catch {
        if (!cancelled) setMapError(true)
      }
    }
    void initialize()
    return () => {
      cancelled = true
      map?.remove()
    }
  }, [stops, itinerary])

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
      <div ref={mapElementRef} className="h-full w-full" aria-label={`Interactive itinerary map for ${destination}`} />
      <div className="pointer-events-none absolute bottom-3 left-3 z-[400] flex flex-wrap gap-2">
        {days.map(day => <span key={day} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-[#071522]/90 px-3 py-1.5 text-[11px] font-bold text-white shadow-lg backdrop-blur"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: MAP_DAY_COLORS[(day - 1) % MAP_DAY_COLORS.length] }} />DAY {day}</span>)}
      </div>
      <div className="absolute right-3 top-3 z-[400] max-w-[245px] rounded-lg border border-white/10 bg-[#071522]/90 px-3 py-2 text-[11px] leading-4 text-[#D5E5EF] shadow-lg backdrop-blur">
        {routeStatus === 'loading' ? 'Finding road routes…' : routeStatus === 'ready' ? 'Road routes via OSRM · driving-route preview' : routeStatus === 'partial' ? 'Some routes are unavailable; markers remain visible.' : 'Road routing unavailable. Showing place markers.'}
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
    name: 'Puri',
    region: 'Odisha, India',
    description: 'Temple heritage, ocean sunsets and local food.',
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
    description: 'Colorful markets, forts and beautiful architecture.',
    image: 'https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=900&q=85',
    tag: 'History & culture',
  },
  {
    name: 'Manali',
    region: 'Himachal Pradesh, India',
    description: 'Mountain views, fresh air and scenic trails.',
    image: 'https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=900&q=85',
    tag: 'Mountain break',
  },
  {
    name: 'Meghalaya',
    region: 'Northeast India',
    description: 'Misty hills, waterfalls and lush green landscapes.',
    image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85',
    tag: 'Nature & adventure',
  },
  {
    name: 'Varanasi',
    region: 'Uttar Pradesh, India',
    description: 'Riverfront walks, old streets and living traditions.',
    image: 'https://images.unsplash.com/photo-1561361058-c24cecae35ca?auto=format&fit=crop&w=900&q=85',
    tag: 'Heritage',
  },
]

const interestOptions = ['Nature', 'History', 'Local food', 'Adventure', 'Photography', 'Popular / hot']

const fieldClass = 'w-full rounded-xl border border-[#2B4A60] bg-[#091B2A] px-4 py-3 text-[#ECF5FC] outline-none transition placeholder:text-[#7E98AA] focus:border-[#57DCC6] focus:ring-2 focus:ring-[#57DCC6]/15'
const fieldLabelClass = 'block text-sm font-semibold text-[#D9E7F1]'
const formatINR = (amount: number) => `₹${amount.toLocaleString('en-IN')}`

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
  const [travelers, setTravelers] = useState('2')
  const [transport, setTransport] = useState('Flexible')
  const [interests, setInterests] = useState<string[]>(['History', 'Local food'])
  const [apiDestinations, setApiDestinations] = useState<ApiDestination[]>([])
  const [exploreDestinations, setExploreDestinations] = useState<ApiDestination[]>([])
  const [exploreError, setExploreError] = useState<string | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [trip, setTrip] = useState<Trip | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [savedTrips, setSavedTrips] = useState<Trip[]>([])
  const [savedTripsError, setSavedTripsError] = useState<string | null>(null)
  const [openingTripId, setOpeningTripId] = useState<number | null>(null)
  const heroSectionRef = useRef<HTMLElement>(null)
  const spotlightRef = useRef<HTMLDivElement>(null)

  const clearPlanResult = () => {
    setTrip(null)
    setPlanError(null)
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

  useEffect(() => {
    let active = true
    searchDestinations()
      .then((items) => {
        if (!active) return
        setApiDestinations(items)
        setExploreDestinations(items)
      })
      .catch(() => {
        // The Explore screen identifies its intentional local visual fallback.
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (view !== 'explore') return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setIsSearching(true)
      try {
        // The client owns the request lifetime; API errors retain a readable fallback.
        const items = await searchDestinations(search, controller.signal)
        if (!controller.signal.aborted) {
          setExploreDestinations(items)
          setExploreError(null)
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
    if (view === 'plan') void loadSavedTrips()
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

  // 1. Cursor-following spotlight on the homepage hero background
  useEffect(() => {
    if (view !== 'home') return

    const hero = heroSectionRef.current
    const spotlight = spotlightRef.current
    if (!hero || !spotlight) return

    // Disable spotlight on touchscreens or when reduced-motion is requested
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
      // Smooth lerp easing factor for natural following
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

    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const rect = hero.getBoundingClientRect()
      targetX = e.clientX - rect.left
      targetY = e.clientY - rect.top

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

    hero.addEventListener('pointermove', handlePointerMove, { passive: true })
    hero.addEventListener('pointerleave', handlePointerLeave, { passive: true })

    return () => {
      hero.removeEventListener('pointermove', handlePointerMove)
      hero.removeEventListener('pointerleave', handlePointerLeave)
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [view])

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
    () => (exploreError ? fallbackSearchResults : exploreDestinations.map(toDestinationCard)),
    [exploreDestinations, exploreError, fallbackSearchResults],
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
    try {
      const generatedTrip = await generatePlan({
        destination: destination.trim(),
        duration: parsedDuration,
        budget: parsedBudget,
        travelers: parsedTravelers,
        transport,
        interests,
      })
      setTrip(generatedTrip)
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

  const openSavedTrip = async (tripId: number) => {
    setOpeningTripId(tripId)
    setPlanError(null)
    try {
      const savedTrip = await getTrip(tripId)
      setTrip(savedTrip)
      setDestination(savedTrip.destination)
      setDuration(String(savedTrip.duration))
      setBudget(String(savedTrip.budget))
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
    <main className="min-h-screen overflow-hidden bg-[#071522] text-[#ECF5FC] selection:bg-[#57DCC6]/30 selection:text-white">
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
          ref={heroSectionRef}
          className="relative isolate flex min-h-[calc(100svh-73px)] w-full flex-col items-center justify-center overflow-hidden px-5 py-12 sm:px-8 sm:py-16"
        >
          <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
            <div className="absolute left-1/2 top-[-7rem] h-[28rem] w-[38rem] -translate-x-1/2 rounded-full bg-cyan-500/[0.10] blur-[100px]" />
            <div className="absolute -right-28 bottom-[-5rem] h-80 w-80 rounded-full bg-blue-500/[0.12] blur-[90px]" />
            {/* 1. Cursor-following spotlight */}
            <div
              ref={spotlightRef}
              className="pointer-events-none absolute -left-[325px] -top-[325px] h-[650px] w-[650px] rounded-full opacity-0 transition-opacity duration-700 ease-out"
              style={{
                background: 'radial-gradient(circle, rgba(87, 220, 198, 0.14) 0%, rgba(56, 189, 248, 0.07) 35%, rgba(7, 21, 34, 0) 70%)',
                willChange: 'transform, opacity',
              }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 opacity-[0.22] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
              style={{
                backgroundImage: 'linear-gradient(rgba(148, 181, 203, 0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(148, 181, 203, 0.10) 1px, transparent 1px)',
                backgroundSize: '48px 48px',
              }}
            />
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
            <p className="animate-hero-subdesc mt-3 text-xs font-medium tracking-wide text-[#7F9BAF] sm:text-sm">
              Explore new places or start planning a trip made around you.
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
        <section className="mx-auto min-h-[calc(100svh-73px)] w-full max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
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
          ) : (
            <div className="mt-12 rounded-2xl border border-dashed border-[#35566A] bg-[#0C2232]/60 p-10 text-center text-sm text-[#A8BECE]">
              <p>No curated Explore cards match “{search}”. You can still plan any destination with Gemma's recommendations.</p>
              <button type="button" onClick={() => openPlanner(search.trim())} className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#57DCC6]/30 bg-[#123B45] px-4 py-2.5 text-sm font-semibold text-[#83EAD9] transition hover:bg-[#174A55]">
                Plan {search.trim() ? `a trip to ${search.trim()}` : 'a trip'} <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>
      )}

      {view === 'plan' && (
        <section className="mx-auto min-h-[calc(100svh-73px)] w-full max-w-4xl px-5 py-9 sm:px-8 sm:py-12">
          <button type="button" onClick={() => window.history.back()} className="inline-flex items-center gap-2 text-sm font-semibold text-[#9BB2C2] transition hover:text-[#78E7D4]">
            <ArrowLeft size={16} /> Back
          </button>
          <div className="mt-6 rounded-2xl border border-[#29485C] bg-gradient-to-br from-[#0F2A3C] via-[#0B2030] to-[#0A1C2A] p-5 sm:p-7">
            <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-[#78E7D4]"><Sparkles size={14} /> Gemma-powered trip planner</p>
            <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Make a plan that fits you.</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#B4C7D6] sm:text-base">Tell us what your trip should look like. Hosted Gemma recommends the places; Geoapify resolves their coordinates, and open routing tools optimize the day-by-day route.</p>
          </div>

          <form onSubmit={generateItinerary} className="mt-5 rounded-2xl border border-[#29485C] bg-[#0B2030] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.16)] sm:p-7">
            <div className="grid gap-5 sm:grid-cols-2">
              <div className={fieldLabelClass}>
                <label htmlFor="trip-destination" className="mb-2 flex items-center gap-2"><MapPin size={16} className="text-[#70E6D2]" /> Destination</label>
                <div className="relative">
                  <Search size={17} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7E98AA]" />
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
                    className={`${fieldClass} pl-11`}
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
              </div>

              <label className={fieldLabelClass}>
                <span className="mb-2 flex items-center gap-2"><CalendarDays size={16} className="text-[#70E6D2]" /> Duration</span>
                <select value={duration} onChange={(event) => { setDuration(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => <option key={day} value={String(day)}>{day} {day === 1 ? 'day' : 'days'}</option>)}
                </select>
              </label>

              <div className={fieldLabelClass}>
                <label htmlFor="trip-budget" className="mb-2 flex items-center gap-2"><Wallet size={16} className="text-[#70E6D2]" /> Total budget (₹)</label>
                <input
                  id="trip-budget"
                  required
                  type="number"
                  min="500"
                  max="100000"
                  step="500"
                  value={budget}
                  onChange={(event) => { setBudget(event.target.value); clearPlanResult() }}
                  className={fieldClass}
                />
                <div className="mt-3 rounded-xl border border-[#2B4A60] bg-[#091B2A]/70 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-[#8EA9BB]">Adjust your budget</span>
                    <span className="font-bold tabular-nums text-[#78E7D4]">₹{Number(budget || 0).toLocaleString('en-IN')}</span>
                  </div>
                  <input
                    aria-label="Adjust total trip budget"
                    type="range"
                    min="500"
                    max="100000"
                    step="500"
                    value={Math.min(100000, Math.max(500, Number(budget) || 500))}
                    onChange={(event) => { setBudget(event.target.value); clearPlanResult() }}
                    className="mt-3 w-full cursor-pointer accent-[#57DCC6]"
                  />
                  <div className="flex justify-between text-[11px] font-medium text-[#7894A7]">
                    <span>₹500</span>
                    <span>₹1,00,000</span>
                  </div>
                </div>
              </div>

              <label className={fieldLabelClass}>
                <span className="mb-2 flex items-center gap-2"><Users size={16} className="text-[#70E6D2]" /> Travelers</span>
                <select value={travelers} onChange={(event) => { setTravelers(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={String(count)}>{count} {count === 1 ? 'traveler' : 'travelers'}</option>)}
                </select>
              </label>

              <label className={`${fieldLabelClass} sm:col-span-2`}>
                <span className="mb-2 block">Transportation preference</span>
                <select value={transport} onChange={(event) => { setTransport(event.target.value); clearPlanResult() }} className={fieldClass}>
                  {['Flexible', 'Public transport', 'Walking', 'Cab', 'Rental vehicle'].map((option) => <option key={option}>{option}</option>)}
                </select>
              </label>
            </div>

            <fieldset className="mt-6">
              <legend className="sr-only">What are you interested in?</legend>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[#D9E7F1]">What are you interested in?</p>
                <button
                  type="button"
                  onClick={toggleAllInterests}
                  aria-pressed={allInterestsSelected}
                  className="rounded-full border border-[#57DCC6]/35 bg-[#0D2A37] px-3 py-1.5 text-xs font-bold text-[#8AECDD] transition hover:border-[#57DCC6]/70 hover:bg-[#123D43]"
                >
                  {allInterestsSelected ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-[#819BAD]">Choose a few interests or select all. “Popular / hot” favors well-known must-visit places; it is not a live trend feed.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {interestOptions.map((interest) => {
                  const selected = interests.includes(interest)
                  const isPopular = interest === 'Popular / hot'
                  return (
                    <button
                      key={interest}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => { toggleInterest(interest); clearPlanResult() }}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition ${selected ? 'border-[#57DCC6]/60 bg-[#123D43] font-semibold text-[#8AECDD]' : 'border-[#2B4A60] bg-[#091B2A] text-[#B1C4D2] hover:border-[#57DCC6]/45 hover:text-white'}`}
                    >
                      {selected && <Check size={14} />}{isPopular ? '🔥 ' : ''}{interest}
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
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button disabled={isGenerating} type="submit" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#25BCA5] to-[#379CC4] px-5 py-3.5 font-bold text-[#041923] shadow-[0_8px_24px_rgba(37,188,165,0.16)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-80 sm:w-auto">
                {isGenerating ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Sparkles size={17} aria-hidden="true" />}
                {isGenerating ? 'Generating itinerary…' : 'Generate itinerary'}
                {!isGenerating && <ArrowRight size={17} aria-hidden="true" />}
              </button>
              {isGenerating && (
                <p role="status" aria-live="polite" className="inline-flex items-center gap-2 text-xs leading-5 text-[#9EB7C7]">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#57DCC6]" aria-hidden="true" />
                  Finding places and optimizing your route. You can keep using RoamWise.
                </p>
              )}
            </div>
            <p className="mt-3 text-xs leading-5 text-[#819BAD]">Hosted Gemma recommends the places; Geoapify is used to resolve destinations and place coordinates. OpenStreetMap-based routing is best-effort. Costs are illustrative estimates, not live quotes or bookings.</p>
          </form>

          {trip && (
            <section aria-live="polite" className="mt-6 overflow-hidden rounded-3xl border border-[#2B5967] bg-[#0A202D] shadow-[0_22px_70px_rgba(0,0,0,0.22)]">
              <div className="p-5 sm:p-7">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div>
                    <p className="inline-flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]"><Sparkles size={14} /> Your journey at a glance · itinerary #{trip.id}</p>
                    <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{trip.destination} · {trip.duration} {trip.duration === 1 ? 'day' : 'days'}</h2>
                    <p className="mt-2 text-sm text-[#B4C7D6]">{trip.travelers} {trip.travelers === 1 ? 'traveler' : 'travelers'} <span className="mx-1 text-[#55778A]">·</span> {trip.transport} <span className="mx-1 text-[#55778A]">·</span> {formatINR(trip.budget)} group budget</p>
                  </div>
                  <div className={`inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3.5 py-2 text-sm font-bold ${trip.is_within_budget ? 'border-[#57DCC6]/25 bg-[#123D43] text-[#8AECDD]' : 'border-rose-300/25 bg-rose-400/10 text-rose-100'}`}>
                    <span className={`h-2 w-2 rounded-full ${trip.is_within_budget ? 'bg-[#57DCC6]' : 'bg-rose-300'}`} />
                    {trip.is_within_budget ? `${formatINR(trip.budget_breakdown.remaining)} remaining` : `${formatINR(trip.budget_breakdown.amount_over_budget)} over budget`}
                  </div>
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
                  <p className="border-t border-[#29485C] px-4 py-3 text-[11px] leading-5 text-[#7898AC] sm:px-5">Map tiles © OpenStreetMap contributors. Road routes are fetched from the public OSRM demo service when available; they are driving-route previews, not live traffic or guaranteed navigation. Cost figures are illustrative estimates, not live prices.</p>
                </div>

                <div className="mt-7 flex items-end justify-between gap-4">
                  <div>
                    <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]">Your day-by-day plan</p>
                    <h3 className="mt-1 text-xl font-bold text-white">Explore at your own pace</h3>
                  </div>
                  <span className="hidden rounded-full border border-[#29485C] px-3 py-1.5 text-xs text-[#A8BECE] sm:inline-flex">{trip.itinerary.reduce((sum, day) => sum + day.activities.length, 0)} planned stops</span>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
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

                <div className="mt-6 rounded-2xl border border-[#29485C] bg-[#081B28] p-5 sm:p-6">
                  <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
                    <div>
                      <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-[#78E7D4]">Budget snapshot</p>
                      <h3 className="mt-1 text-lg font-bold text-white">Illustrative group cost estimate</h3>
                    </div>
                    <p className="text-xl font-extrabold tabular-nums text-white">{formatINR(trip.budget_breakdown.total)}</p>
                  </div>
                  <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {[
                      ['Transport', trip.budget_breakdown.transportation],
                      ['Stay', trip.budget_breakdown.accommodation],
                      ['Food', trip.budget_breakdown.food],
                      ['Entry', trip.budget_breakdown.entry_fees],
                      ['Misc.', trip.budget_breakdown.miscellaneous],
                      ['Total', trip.budget_breakdown.total],
                    ].map(([label, amount]) => (
                      <div key={String(label)} className={`rounded-xl border p-3 ${label === 'Total' ? 'border-[#57DCC6]/25 bg-[#123D43]/60' : 'border-[#29485C] bg-[#0C2232]'}`}>
                        <p className="text-xs text-[#8EA9BB]">{label}</p>
                        <p className="mt-1 text-sm font-extrabold tabular-nums text-white">{String(label) === 'Entry' ? 'Unknown' : formatINR(Number(amount))}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-xs leading-5 text-[#819BAD]">{trip.budget_breakdown.estimate_note} Planner: {trip.planner_engine}.</p>
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

          <section className="mt-6 rounded-2xl border border-[#29485C] bg-[#0B2030] p-5 sm:p-7">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#78E7D4]">Saved trips</p>
                <h2 className="mt-1 text-xl font-bold text-white">Reopen a previous plan</h2>
              </div>
              <button type="button" onClick={() => void loadSavedTrips()} className="rounded-full border border-[#2B4A60] px-3 py-2 text-xs font-semibold text-[#B4C7D6] transition hover:border-[#57DCC6]/50 hover:text-white">Refresh</button>
            </div>
            {savedTripsError && <p role="status" className="mt-4 text-sm text-amber-100">{savedTripsError}</p>}
            {savedTrips.length > 0 ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {savedTrips.map((savedTrip) => (
                  <button key={savedTrip.id} type="button" disabled={openingTripId === savedTrip.id} onClick={() => void openSavedTrip(savedTrip.id)} className="rounded-xl border border-[#2B4A60] bg-[#091E2C] p-4 text-left transition hover:border-[#57DCC6]/45 disabled:opacity-60">
                    <span className="block text-sm font-bold text-white">{savedTrip.destination} · {savedTrip.duration} days</span>
                    <span className="mt-1 block text-xs text-[#8EA9BB]">Plan #{savedTrip.id} · {formatINR(savedTrip.budget_breakdown.total)} estimated</span>
                    <span className="mt-2 block text-xs font-semibold text-[#70E6D2]">{openingTripId === savedTrip.id ? 'Opening…' : 'Open saved plan'}</span>
                  </button>
                ))}
              </div>
            ) : !savedTripsError && <p className="mt-4 text-sm text-[#8EA9BB]">Generate a plan to save it here.</p>}
          </section>
        </section>
      )}
    </main>
  )
}
