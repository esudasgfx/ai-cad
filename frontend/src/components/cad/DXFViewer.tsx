'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { 
  ZoomIn, 
  ZoomOut, 
  Move, 
  Download, 
  Maximize2, 
  Layers,
  Ruler,
  Eye,
  EyeOff,
  RotateCcw,
  Loader,
  AlertCircle
} from 'lucide-react'
import { apiClient } from '@/lib/api'
import DxfParser from 'dxf-parser'
import { Canvas, Line, Circle, Path, Text, Polyline } from 'fabric'

// Fabric.js types (dynamic import)
interface FabricCanvas {
  dispose(): void
  add(obj: any): void
  setZoom(zoom: number): void
  renderAll(): void
  absolutePan(point: { x: number; y: number }): void
  toDataURL(options?: any): string
  clear(): void
  setDimensions(dimensions: { width: number; height: number }): void
  getZoom(): number
  getWidth(): number
  getHeight(): number
}

type FabricModule = any

// DXF parsing types
interface DXFEntity {
  type: string
  layer: string
  color: number
  handle: string
  coordinates?: number[]
  startPoint?: PointTuple
  endPoint?: PointTuple
  radius?: number
  center?: PointTuple
  angle?: number
  text?: string
  // Additional properties that might exist on parsed entities
  x?: number
  y?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  insertPoint?: PointTuple
  vertices?: any[]
  points?: number[]
  startAngle?: number
  endAngle?: number
  rawEntity?: any
}

interface DXFLayer {
  name: string
  color: number
  visible: boolean
  entities: DXFEntity[]
}

interface DXFData {
  layers: Map<string, DXFLayer>
  entities: DXFEntity[]
  bounds: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
  units: string
}

interface DXFViewerProps {
  planId: string
  onLoad?: () => void
  onError?: (error: Error) => void
  className?: string
}

type PointTuple = [number, number]

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
)

const toPointTuple = (point: any): PointTuple | undefined => {
  if (!point) return undefined

  if (Array.isArray(point) && isFiniteNumber(point[0]) && isFiniteNumber(point[1])) {
    return [point[0], point[1]]
  }

  if (isFiniteNumber(point.x) && isFiniteNumber(point.y)) {
    return [point.x, point.y]
  }

  return undefined
}

const toCoordinateArray = (points: any[] | undefined): number[] | undefined => {
  if (!Array.isArray(points)) return undefined

  const coordinates: number[] = []
  points.forEach((point) => {
    const tuple = toPointTuple(point)
    if (tuple) coordinates.push(tuple[0], tuple[1])
  })

  return coordinates.length >= 2 ? coordinates : undefined
}

const updateBoundsWithPoint = (
  bounds: DXFData['bounds'],
  point: PointTuple | undefined
) => {
  if (!point) return

  bounds.minX = Math.min(bounds.minX, point[0])
  bounds.minY = Math.min(bounds.minY, point[1])
  bounds.maxX = Math.max(bounds.maxX, point[0])
  bounds.maxY = Math.max(bounds.maxY, point[1])
}

const updateBoundsWithCoordinates = (
  bounds: DXFData['bounds'],
  coordinates: number[] | undefined
) => {
  if (!coordinates || coordinates.length < 2) return

  for (let i = 0; i < coordinates.length - 1; i += 2) {
    const point: PointTuple = [coordinates[i], coordinates[i + 1]]
    updateBoundsWithPoint(bounds, point)
  }
}

const hasValidBounds = (bounds: DXFData['bounds']) => (
  Number.isFinite(bounds.minX) &&
  Number.isFinite(bounds.minY) &&
  Number.isFinite(bounds.maxX) &&
  Number.isFinite(bounds.maxY) &&
  bounds.maxX > bounds.minX &&
  bounds.maxY > bounds.minY
)

const normalizeAngleForPath = (angle: number | undefined): number | undefined => {
  if (!isFiniteNumber(angle)) return undefined

  // dxf-parser emits arc angles in radians; older/custom data may already use degrees.
  return Math.abs(angle) <= Math.PI * 2 ? (angle * 180) / Math.PI : angle
}

export default function DXFViewer({ planId, onLoad, onError, className }: DXFViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const fabricCanvasRef = useRef<FabricCanvas | null>(null)
  
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dxfData, setDxfData] = useState<DXFData | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [showLayers, setShowLayers] = useState(true)
  const [showRulers, setShowRulers] = useState(true)
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null)
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({})

  // Parse DXF content
  const parseDXF = useCallback((content: string): DXFData => {
    console.log('🔍 DXF Viewer Debug: Creating DXF parser...')
    console.log('   Content length:', content.length)
    console.log('   Content preview:', content.substring(0, 200))
    
    try {
      // Create parser instance using statically imported DxfParser
      const parser = new DxfParser()
      
      console.log('🔍 DXF Viewer Debug: Parser created successfully')
      const dxf = parser.parseSync(content)
      console.log('🔍 DXF Viewer Debug: DXF parsed successfully')
      console.log('   Parsed object:', dxf)
      
      if (!dxf) {
        throw new Error('Failed to parse DXF content - result is null')
      }
      
      const layers = new Map<string, DXFLayer>()
      const entities: DXFEntity[] = []
      let bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }

    // Process layers
    if (dxf.tables?.layer?.layers) {
      Object.entries(dxf.tables.layer.layers).forEach(([name, layer]: [string, any]) => {
        layers.set(name, {
          name,
          color: layer.color || 7,
          visible: true,
          entities: []
        })
      })
    }

    // Process entities
    if (dxf.entities) {
      console.log('🔍 DXF Viewer Debug: Processing entities...')
      console.log('   Total entities:', dxf.entities.length)
      
      dxf.entities.forEach((entity: any, index: number) => {
        console.log(`🔍 DXF Viewer Debug: Entity ${index + 1}:`, {
          type: entity.type,
          layer: entity.layer,
          hasCoordinates: !!entity.coordinates,
          coordinatesLength: entity.coordinates?.length,
          startPoint: entity.startPoint,
          endPoint: entity.endPoint,
          radius: entity.radius,
          center: entity.center
        })
        
        // Debug: Show raw entity data to understand structure
        console.log(`🔍 Raw Entity ${index + 1} Data:`, entity)
        
        // Extract coordinates based on entity type and parser structure
        let coordinates: number[] | undefined
        let startPoint: PointTuple | undefined
        let endPoint: PointTuple | undefined
        let center: PointTuple | undefined = toPointTuple(entity.center)
        let insertPoint: PointTuple | undefined = toPointTuple(entity.insertPoint)
        
        if (entity.type === 'LWPOLYLINE') {
          // LWPOLYLINE coordinates are often in vertices or points
          if (entity.vertices && Array.isArray(entity.vertices)) {
            coordinates = toCoordinateArray(entity.vertices)
          } else if (entity.points && Array.isArray(entity.points)) {
            coordinates = Array.isArray(entity.points[0])
              ? entity.points.flat()
              : entity.points.every(isFiniteNumber)
                ? entity.points
                : toCoordinateArray(entity.points)
          } else if (entity.coordinates && Array.isArray(entity.coordinates)) {
            coordinates = entity.coordinates
          }
          console.log(`🔍 LWPOLYLINE coordinates extracted:`, coordinates)
        } else if (entity.type === 'LINE') {
          // LINE entities can store coordinates in different ways
          console.log(`🔍 Processing LINE entity - checking all possible coordinate locations:`)
          console.log(`   entity.vertices:`, entity.vertices)
          console.log(`   entity.coordinates:`, entity.coordinates)
          console.log(`   entity.startPoint:`, entity.startPoint)
          console.log(`   entity.endPoint:`, entity.endPoint)
          console.log(`   entity.x:`, entity.x, `entity.y:`, entity.y)
          console.log(`   entity.x1:`, entity.x1, `entity.y1:`, entity.y1)
          console.log(`   entity.x2:`, entity.x2, `entity.y2:`, entity.y2)
          
          // Try different coordinate storage patterns
          if (entity.vertices && Array.isArray(entity.vertices) && entity.vertices.length >= 2) {
            startPoint = toPointTuple(entity.vertices[0])
            endPoint = toPointTuple(entity.vertices[1])
            if (startPoint && endPoint) {
              coordinates = [startPoint[0], startPoint[1], endPoint[0], endPoint[1]]
            }
          } else if (entity.startPoint && entity.endPoint) {
            startPoint = toPointTuple(entity.startPoint)
            endPoint = toPointTuple(entity.endPoint)
            if (startPoint && endPoint) {
              coordinates = [startPoint[0], startPoint[1], endPoint[0], endPoint[1]]
            }
          } else if (entity.coordinates && Array.isArray(entity.coordinates) && entity.coordinates.length >= 4) {
            // Flat array [x1, y1, x2, y2]
            startPoint = [entity.coordinates[0], entity.coordinates[1]]
            endPoint = [entity.coordinates[2], entity.coordinates[3]]
            coordinates = entity.coordinates
          } else if (entity.x !== undefined && entity.y !== undefined && entity.x1 !== undefined && entity.y1 !== undefined) {
            // Individual coordinate properties
            startPoint = [entity.x, entity.y]
            endPoint = [entity.x1, entity.y1]
            coordinates = [startPoint[0], startPoint[1], endPoint[0], endPoint[1]]
          } else if (entity.x1 !== undefined && entity.y1 !== undefined && entity.x2 !== undefined && entity.y2 !== undefined) {
            // Individual coordinate properties (alternative naming)
            startPoint = [entity.x1, entity.y1]
            endPoint = [entity.x2, entity.y2]
            coordinates = [startPoint[0], startPoint[1], endPoint[0], endPoint[1]]
          }
          
          console.log(`🔍 LINE points extracted - start:`, startPoint, 'end:', endPoint, 'coordinates:', coordinates)
        } else if (entity.type === 'ARC') {
          // ARC entities have center, radius, and angles
          startPoint = toPointTuple(entity.startPoint)
          endPoint = toPointTuple(entity.endPoint)
          console.log(`🔍 ARC data extracted - center:`, entity.center, 'radius:', entity.radius)
        } else {
          // For other entity types, use the original properties
          coordinates = entity.coordinates
          startPoint = toPointTuple(entity.startPoint)
          endPoint = toPointTuple(entity.endPoint)
          center = toPointTuple(entity.center)
          insertPoint = toPointTuple(entity.insertPoint)
        }
        
        const dxfEntity: DXFEntity = {
          type: entity.type,
          layer: entity.layer || '0',
          color: entity.color || 7,
          handle: entity.handle || '',
          coordinates,
          startPoint,
          endPoint,
          radius: entity.radius,
          center,
          angle: entity.angle,
          text: entity.text,
          insertPoint,
          startAngle: normalizeAngleForPath(entity.startAngle),
          endAngle: normalizeAngleForPath(entity.endAngle),
          // Store raw vertices for rendering fallback
          vertices: (entity as any).vertices,
          // Store the raw entity for deep debugging
          rawEntity: entity
        }

        console.log(`🔍 Created DXF entity:`, {
          type: dxfEntity.type,
          startPoint: dxfEntity.startPoint,
          endPoint: dxfEntity.endPoint,
          coordinates: dxfEntity.coordinates,
          vertices: dxfEntity.vertices
        })

        entities.push(dxfEntity)

        updateBoundsWithPoint(bounds, startPoint)
        updateBoundsWithPoint(bounds, endPoint)

        if (center) {
          const radius = isFiniteNumber(entity.radius) ? entity.radius : 0
          updateBoundsWithPoint(bounds, [center[0] - radius, center[1] - radius])
          updateBoundsWithPoint(bounds, [center[0] + radius, center[1] + radius])
        }

        updateBoundsWithCoordinates(bounds, coordinates)

        // Add to layer
        const layerName = entity.layer || '0'
        if (!layers.has(layerName)) {
          layers.set(layerName, {
            name: layerName,
            color: dxfEntity.color,
            visible: true,
            entities: []
          })
        }
        layers.get(layerName)?.entities.push(dxfEntity)
      })
    }

    // Initialize layer visibility (but don't set state here - handle it outside)
    const initialVisibility: Record<string, boolean> = {}
    layers.forEach((layer, name) => {
      initialVisibility[name] = true
    })

    if (!hasValidBounds(bounds)) {
      bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
    }

    const result = {
      layers,
      entities,
      bounds,
      units: (dxf as any).units || 'Units'
    }
    
    console.log('🔍 DXF Viewer Debug: Parsing complete:', {
      totalLayers: layers.size,
      totalEntities: entities.length,
      bounds,
      entityTypes: entities.reduce((acc, e) => {
        acc[e.type] = (acc[e.type] || 0) + 1
        return acc
      }, {} as Record<string, number>)
    })
    
    return result
    } catch (error) {
      console.error('🔍 DXF Viewer Debug: Error parsing DXF:', error)
      throw new Error(`DXF parsing failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }, [])

  // Fit canvas to content (moved here before it's used)
  const fitToContent = useCallback((canvas: any, data: DXFData) => {
    console.log('📐 DXF Viewer Debug: === FITTING CONTENT TO CANVAS ===')
    
    if (!data.entities.length) {
      console.log('❌ No entities to fit')
      return
    }

    console.log('   Data bounds:', data.bounds)
    
    const padding = 50
    const canvasWidth = canvas.getWidth()
    const canvasHeight = canvas.getHeight()
    
    if (!hasValidBounds(data.bounds)) {
      setZoom(1)
      canvas.setZoom(1)
      canvas.absolutePan({ x: 0, y: 0 })
      canvas.renderAll()
      return
    }
    
    const contentWidth = (data.bounds.maxX - data.bounds.minX) * 10
    const contentHeight = (data.bounds.maxY - data.bounds.minY) * 10
    
    console.log('   Content dimensions:', { contentWidth, contentHeight })
    console.log('   Canvas dimensions:', { canvasWidth, canvasHeight })
    console.log('   Content bounds check:', {
      minX: data.bounds.minX,
      maxX: data.bounds.maxX,
      minY: data.bounds.minY,
      maxY: data.bounds.maxY,
      boundsValid: data.bounds.maxX > data.bounds.minX && data.bounds.maxY > data.bounds.minY
    })
    
    if (
      !Number.isFinite(contentWidth) ||
      !Number.isFinite(contentHeight) ||
      contentWidth <= 0 ||
      contentHeight <= 0 ||
      canvasWidth <= padding * 2 ||
      canvasHeight <= padding * 2
    ) {
      setZoom(1)
      canvas.setZoom(1)
      canvas.absolutePan({ x: 0, y: 0 })
      canvas.renderAll()
      return
    }

    const scaleX = (canvasWidth - padding * 2) / contentWidth
    const scaleY = (canvasHeight - padding * 2) / contentHeight
    const scale = Math.min(scaleX, scaleY, 2) // Max zoom 2x
    
    console.log('🔍 DXF Viewer Debug: Calculated scale:', scale)
    
    if (!Number.isFinite(scale) || scale <= 0) {
      setZoom(1)
      canvas.setZoom(1)
      canvas.absolutePan({ x: 0, y: 0 })
      canvas.renderAll()
      return
    }

    setZoom(scale)
    canvas.setZoom(scale)
    
    // Center content
    const centerX = (canvasWidth - contentWidth * scale) / 2
    const centerY = (canvasHeight - contentHeight * scale) / 2
    canvas.absolutePan({ x: centerX, y: centerY })
    
    canvas.renderAll()
    console.log('🔍 DXF Viewer Debug: Content fitting complete')
  }, [])

  // Load DXF file
  const loadDXF = useCallback(async () => {
    if (!planId) return

    setIsLoading(true)
    setError(null)

    try {
      // Download DXF file from backend using API client
      const dxfBlob = await apiClient.downloadPlan(planId, 'dxf')
      
      if (!dxfBlob || dxfBlob.size === 0) {
        throw new Error('DXF file is empty or invalid')
      }

      // Convert blob to text for parsing
      const dxfContent = await dxfBlob.text()
      
      if (!dxfContent || dxfContent.trim() === '') {
        throw new Error('DXF file content is empty or invalid')
      }

      // Parse DXF content
      const parsedData = parseDXF(dxfContent)
      
      // Initialize layer visibility from parsed data
      const initialVisibility: Record<string, boolean> = {}
      parsedData.layers.forEach((layer, name) => {
        initialVisibility[name] = true
      })
      setLayerVisibility(initialVisibility)
      
      setDxfData(parsedData)
      onLoad?.()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load DXF file'
      setError(errorMessage)
      onError?.(err instanceof Error ? err : new Error(errorMessage))
    } finally {
      setIsLoading(false)
    }
  }, [planId, onLoad, onError])

  // Render DXF entities on canvas (moved here before it's used)
  const renderDXFEntities = useCallback((canvas: any, data: DXFData) => {
    console.log('🎨 DXF Viewer Debug: === STARTING RENDERING PHASE ===')
    console.log('   Canvas object:', canvas)
    console.log('   Canvas dimensions:', canvas ? { width: canvas.getWidth(), height: canvas.getHeight() } : 'null canvas')
    console.log('   Total entities to render:', data.entities.length)
    console.log('   Layer visibility:', layerVisibility)
    console.log('   Entity data preview:', data.entities.slice(0, 2).map(e => ({
      type: e.type,
      layer: e.layer,
      hasCoordinates: !!e.coordinates,
      hasVertices: !!(e as any).vertices,
      startPoint: e.startPoint,
      endPoint: e.endPoint
    })))
    
    const scale = 10 // Scale factor for better visibility
    const offsetX = 50
    const offsetY = 50
    
    let renderedCount = 0

    data.entities.forEach((entity, index) => {
      console.log(`🔍 DXF Viewer Debug: Rendering entity ${index + 1}:`, {
        type: entity.type,
        layer: entity.layer,
        visible: layerVisibility[entity.layer],
        coordinates: entity.coordinates,
        startPoint: entity.startPoint,
        endPoint: entity.endPoint
      })
      
      if (layerVisibility[entity.layer] === false) {
        console.log(`   Skipping entity ${index + 1} - layer ${entity.layer} not visible`)
        return
      }

      let fabricObject: any = null
      const color = getColorFromIndex(entity.color)

      switch (entity.type) {
        case 'LINE':
          console.log(`🔍 Rendering LINE entity:`, {
            startPoint: entity.startPoint,
            endPoint: entity.endPoint,
            coordinates: entity.coordinates,
            vertices: (entity as any).vertices
          })
          
          // Try different coordinate sources for LINE entities
          let lineStart = entity.startPoint
          let lineEnd = entity.endPoint
          
          // If startPoint/endPoint are missing, try to extract from vertices or original entity
          if ((!lineStart || !lineEnd) && (entity as any).vertices && Array.isArray((entity as any).vertices) && (entity as any).vertices.length >= 2) {
            const vertices = (entity as any).vertices
            lineStart = [vertices[0].x, vertices[0].y]
            lineEnd = [vertices[1].x, vertices[1].y]
            console.log(`✅ Extracted LINE coordinates from stored vertices:`, { lineStart, lineEnd })
          } else if ((!lineStart || !lineEnd) && (entity as any).coordinates && Array.isArray((entity as any).coordinates) && (entity as any).coordinates.length >= 4) {
            const coords = (entity as any).coordinates
            lineStart = [coords[0], coords[1]]
            lineEnd = [coords[2], coords[3]]
            console.log(`✅ Extracted LINE coordinates from stored coordinates:`, { lineStart, lineEnd })
          } else {
            // Last resort: try to parse from raw entity data if available
            const rawEntity = (entity as any).rawEntity || (entity as any)._raw
            if (rawEntity && rawEntity.vertices && Array.isArray(rawEntity.vertices) && rawEntity.vertices.length >= 2) {
              const vertices = rawEntity.vertices
              lineStart = [vertices[0].x, vertices[0].y]
              lineEnd = [vertices[1].x, vertices[1].y]
              console.log(`✅ Extracted LINE coordinates from raw entity:`, { lineStart, lineEnd })
            }
          }
          
          if (lineStart && lineEnd && lineStart.length >= 2 && lineEnd.length >= 2) {
            fabricObject = new Line([
              lineStart[0] * scale + offsetX,
              lineStart[1] * scale + offsetY,
              lineEnd[0] * scale + offsetX,
              lineEnd[1] * scale + offsetY
            ], {
              stroke: color,
              strokeWidth: 1,
              selectable: false
            })
            console.log(`✅ Created LINE Fabric object`)
          } else {
            console.log(`❌ Failed to render LINE - missing coordinates:`, { lineStart, lineEnd })
          }
          break

        case 'CIRCLE':
          if (entity.center && entity.radius) {
            fabricObject = new Circle({
              left: (entity.center[0] - entity.radius) * scale + offsetX,
              top: (entity.center[1] - entity.radius) * scale + offsetY,
              radius: entity.radius * scale,
              fill: 'transparent',
              stroke: color,
              strokeWidth: 1,
              selectable: false
            })
          }
          break

        case 'ARC':
          // Convert arc to path
          if (entity.center && entity.radius && 
              entity.startAngle !== undefined && 
              entity.endAngle !== undefined) {
            const path = createArcPath(
              entity.center[0] * scale + offsetX,
              entity.center[1] * scale + offsetY,
              entity.radius * scale,
              entity.startAngle,
              entity.endAngle
            )
            fabricObject = new Path(path, {
              fill: 'transparent',
              stroke: color,
              strokeWidth: 1,
              selectable: false
            })
          }
          break

        case 'TEXT':
          console.log(`🔍 Processing TEXT entity:`, {
            text: entity.text,
            startPoint: entity.startPoint,
            center: entity.center,
            x: entity.x, y: entity.y,
            insertPoint: entity.insertPoint,
            textData: entity
          })
          
          // TEXT entities can store position in different ways
          let textPosition: PointTuple | undefined = entity.startPoint
          if (!textPosition && entity.center) {
            textPosition = entity.center
          } else if (!textPosition && entity.x !== undefined && entity.y !== undefined) {
            textPosition = [entity.x, entity.y]
          } else if (!textPosition && entity.insertPoint) {
            textPosition = entity.insertPoint
          }
          
          console.log(`🔍 TEXT position extracted:`, textPosition)
          
          if (entity.text && textPosition) {
            fabricObject = new Text(entity.text, {
              left: textPosition[0] * scale + offsetX,
              top: textPosition[1] * scale + offsetY,
              fontSize: 12,
              fill: color,
              selectable: false
            })
          }
          break

        case 'POLYLINE':
        case 'LWPOLYLINE':
          if (entity.coordinates && entity.coordinates.length >= 2 && entity.coordinates.length % 2 === 0) {
            if (entity.type === 'LWPOLYLINE') {
              // Convert flat array to points array
              const pointPairs = []
              for (let i = 0; i < entity.coordinates.length; i += 2) {
                pointPairs.push({ 
                  x: entity.coordinates[i] * scale + offsetX, 
                  y: entity.coordinates[i + 1] * scale + offsetY 
                })
              }
              fabricObject = new Polyline(pointPairs, {
                fill: 'transparent',
                stroke: color,
                strokeWidth: 1,
                selectable: false
              })
            } else {
              const points = entity.coordinates.map((coord: number, index: number) => {
                if (index % 2 === 0) {
                  return { x: coord * scale + offsetX }
                }
                return { y: coord * scale + offsetY }
              }).reduce((acc: any[], point: any, index: number) => {
                if (index % 2 === 0) {
                  acc.push({ x: point.x, y: entity.coordinates![index + 1] * scale + offsetY })
                }
                return acc
              }, [])
              
              fabricObject = new Polyline(points, {
                fill: 'transparent',
                stroke: color,
                strokeWidth: 1,
                selectable: false
              })
            }
          }
          break
      }

      if (fabricObject) {
        console.log(`   ✓ Created Fabric.js object for entity ${index + 1}:`, fabricObject)
        canvas.add(fabricObject)
        renderedCount++
      } else {
        console.log(`   ❌ Failed to create Fabric.js object for entity ${index + 1}`)
      }
    })

    console.log(`🎨 DXF Viewer Debug: === RENDERING COMPLETE ===`)
    console.log(`   Successfully rendered ${renderedCount} out of ${data.entities.length} entities`)
    console.log(`   Canvas objects count:`, canvas ? canvas.getObjects().length : 'null canvas')
    console.log(`   Canvas background:`, canvas ? canvas.backgroundColor : 'null canvas')
    
    if (canvas && canvas.getObjects().length > 0) {
      console.log(`   Canvas object types:`, canvas.getObjects().map((obj: any) => obj.type))
    } else {
      console.log(`   ⚠️  No objects on canvas - this is why the screen is blank!`)
    }
    
    canvas.renderAll()
    console.log(`   Canvas renderAll() called`)
  }, [layerVisibility])

  // Initialize Fabric.js canvas
  const initializeCanvas = useCallback(() => {
    console.log('🖼️ DXF Viewer Debug: === CANVAS INITIALIZATION ===')
    console.log('   Canvas element:', canvasRef.current)
    console.log('   Container element:', containerRef.current)
    console.log('   Container dimensions:', containerRef.current ? {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight
    } : 'null container')
    console.log('   DXF data available:', !!dxfData)
    console.log('   DXF entities count:', dxfData ? dxfData.entities.length : 0)
    
    if (!canvasRef.current || !dxfData) {
      console.log('❌ Cannot initialize canvas - missing elements')
      return
    }

    // Dispose existing canvas
    if (fabricCanvasRef.current) {
      console.log('🔍 DXF Viewer Debug: Disposing existing canvas')
      fabricCanvasRef.current.dispose()
    }

    // Create new canvas using Canvas constructor
    const containerWidth = containerRef.current?.clientWidth || 800
    console.log('🔍 DXF Viewer Debug: Creating new canvas with width:', containerWidth)
    
    const canvas = new Canvas(canvasRef.current, {
      width: containerWidth,
      height: 600,
      backgroundColor: '#f8f9fa',
      selection: false
    })

    console.log('🖼️ DXF Viewer Debug: Canvas created successfully:', canvas)
    console.log('   Canvas initial dimensions:', { width: canvas.getWidth(), height: canvas.getHeight() })
    console.log('   Canvas background:', canvas.backgroundColor)
    fabricCanvasRef.current = canvas

    // Render DXF entities
    console.log('🖼️ DXF Viewer Debug: Starting entity rendering...')
    renderDXFEntities(canvas, dxfData)

    // Set initial zoom to fit content
    console.log('🖼️ DXF Viewer Debug: Fitting content to canvas...')
    fitToContent(canvas, dxfData)
    
    console.log('🖼️ DXF Viewer Debug: Canvas initialization complete')
    console.log('   Final canvas objects count:', canvas.getObjects().length)
    console.log('   Final canvas dimensions:', { width: canvas.getWidth(), height: canvas.getHeight() })
    console.log('   Final canvas zoom:', canvas.getZoom())
  }, [dxfData, renderDXFEntities, fitToContent])

  

  // Helper function to create arc path
  const createArcPath = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string => {
    const start = polarToCartesian(cx, cy, radius, endAngle)
    const end = polarToCartesian(cx, cy, radius, startAngle)
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1"
    return [
      "M", start.x, start.y,
      "A", radius, radius, 0, largeArcFlag, 0, end.x, end.y
    ].join(" ")
  }

  const polarToCartesian = (centerX: number, centerY: number, radius: number, angleInDegrees: number) => {
    const angleInRadians = (angleInDegrees * Math.PI) / 180.0
    return {
      x: centerX + (radius * Math.cos(angleInRadians)),
      y: centerY + (radius * Math.sin(angleInRadians))
    }
  }

  // Helper function to get color from AutoCAD color index
  const getColorFromIndex = (colorIndex: number): string => {
    const colors: Record<number, string> = {
      1: '#ff0000', 2: '#b59f00', 3: '#00aa00', 4: '#00aaaa',
      5: '#0000ff', 6: '#ff00ff', 7: '#111827', 8: '#808080',
      9: '#404040', 10: '#ff8080', 11: '#ffff80', 12: '#80ff80',
      13: '#80ffff', 14: '#8080ff', 15: '#ff80ff', 16: '#c0c0c0',
      17: '#804040', 18: '#808000', 19: '#408000', 20: '#408080',
      21: '#004080', 22: '#404080', 23: '#800080', 24: '#804040',
      25: '#111827'
    }
    return colors[colorIndex] || '#111827'
  }

  

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    if (!fabricCanvasRef.current) return
    const newZoom = Math.min(zoom * 1.2, 5)
    setZoom(newZoom)
    fabricCanvasRef.current.setZoom(newZoom)
    fabricCanvasRef.current.renderAll()
  }, [zoom])

  const handleZoomOut = useCallback(() => {
    if (!fabricCanvasRef.current) return
    const newZoom = Math.max(zoom / 1.2, 0.1)
    setZoom(newZoom)
    fabricCanvasRef.current.setZoom(newZoom)
    fabricCanvasRef.current.renderAll()
  }, [zoom])

  const handleZoomReset = useCallback(() => {
    if (!fabricCanvasRef.current || !dxfData) return
    fitToContent(fabricCanvasRef.current, dxfData)
  }, [dxfData, fitToContent])

  // Pan controls
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true)
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || !fabricCanvasRef.current) return
    
    const newX = e.clientX - dragStart.x
    const newY = e.clientY - dragStart.y
    
    setPan({ x: newX, y: newY })
    fabricCanvasRef.current.absolutePan({ x: newX, y: newY })
  }, [isDragging, dragStart])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Layer visibility toggle
  const toggleLayerVisibility = useCallback((layerName: string) => {
    setLayerVisibility(prev => ({
      ...prev,
      [layerName]: !prev[layerName]
    }))
  }, [])

  // Export functions
  const handleExportPNG = useCallback(() => {
    if (!fabricCanvasRef.current) return
    
    const dataURL = fabricCanvasRef.current.toDataURL({
      format: 'png',
      quality: 1,
      multiplier: 2
    })
    
    const link = document.createElement('a')
    link.download = `floor-plan-${planId}.png`
    link.href = dataURL
    link.click()
  }, [planId])

  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    
    if (containerRef.current.requestFullscreen) {
      containerRef.current.requestFullscreen()
    }
  }, [])

  // Load DXF when planId changes
  useEffect(() => {
    if (planId) {
      loadDXF()
    }
  }, [planId])

  // Initialize canvas when DXF data is loaded
  useEffect(() => {
    if (dxfData) {
      initializeCanvas()
    }
  }, [dxfData, initializeCanvas])

  // Re-render when layer visibility changes
  useEffect(() => {
    if (fabricCanvasRef.current && dxfData) {
      fabricCanvasRef.current.clear()
      renderDXFEntities(fabricCanvasRef.current, dxfData)
    }
  }, [layerVisibility, dxfData, renderDXFEntities])

  // Handle window resize and canvas sizing
  useEffect(() => {
    const handleResize = () => {
      console.log('🪟 DXF Viewer Debug: Window resize event')
      if (fabricCanvasRef.current && containerRef.current) {
        const newWidth = containerRef.current.clientWidth
        console.log('   Resizing canvas to:', { width: newWidth, height: 600 })
        fabricCanvasRef.current.setDimensions({
          width: newWidth,
          height: 600
        })
        fabricCanvasRef.current.renderAll()
      }
    }

    // Also log initial canvas setup
    setTimeout(() => {
      console.log('🪟 DXF Viewer Debug: Initial canvas setup check')
      console.log('   Container element:', containerRef.current)
      console.log('   Canvas element:', canvasRef.current)
      console.log('   Fabric canvas:', fabricCanvasRef.current)
      console.log('   Container computed style:', containerRef.current ? window.getComputedStyle(containerRef.current) : 'no container')
      
      if (canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect()
        console.log('   Canvas element rect:', rect)
        console.log('   Canvas element visible:', rect.width > 0 && rect.height > 0)
      }
    }, 1000)

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96 bg-muted rounded-lg">
        <div className="text-center">
          <Loader className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading DXF file...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96 bg-muted rounded-lg">
        <div className="text-center max-w-md">
          <AlertCircle className="w-8 h-8 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">Failed to Load DXF</h3>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button onClick={loadDXF} variant="outline">
            <RotateCcw className="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 bg-muted rounded-lg">
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={handleZoomIn}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleZoomOut}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleZoomReset}>
            <RotateCcw className="w-4 h-4" />
          </Button>
          <div className="px-3 py-1 bg-background rounded border text-sm">
            {Math.round(zoom * 100)}%
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => setShowRulers(!showRulers)}>
            <Ruler className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowLayers(!showLayers)}>
            <Layers className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportPNG}>
            <Download className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={handleFullscreen}>
            <Maximize2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex space-x-4">
        {/* Main Canvas */}
        <div className="flex-1">
          <div 
            ref={containerRef}
            className="border rounded-lg overflow-hidden bg-white"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{ 
              cursor: isDragging ? 'grabbing' : 'grab',
              minHeight: '600px',
              minWidth: '800px',
              position: 'relative'
            }}
          >
            <canvas ref={canvasRef} className="block" />
          </div>
        </div>

        {/* Layers Panel */}
        {showLayers && dxfData && (
          <div className="w-64 bg-muted rounded-lg p-4">
            <h3 className="font-medium text-foreground mb-3 flex items-center">
              <Layers className="w-4 h-4 mr-2" />
              Layers
            </h3>
            <div className="space-y-2">
              {Array.from(dxfData.layers.entries()).map(([name, layer]) => (
                <div 
                  key={name}
                  className="flex items-center justify-between p-2 bg-background rounded border"
                >
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => toggleLayerVisibility(name)}
                      className="p-1 hover:bg-muted rounded"
                    >
                      {layerVisibility[name] ? (
                        <Eye className="w-4 h-4 text-foreground" />
                      ) : (
                        <EyeOff className="w-4 h-4 text-muted-foreground" />
                      )}
                    </button>
                    <div 
                      className="w-3 h-3 rounded border"
                      style={{ backgroundColor: getColorFromIndex(layer.color) }}
                    />
                    <span className="text-sm text-foreground">{name}</span>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {layer.entities.length}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}