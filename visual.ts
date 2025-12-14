"use strict";

// Leaflet & Esri Leaflet
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import * as LEsri from "esri-leaflet";
type EsriFeatureLayer = ReturnType<typeof LEsri.featureLayer>;

// Grouped Layer Control
import "leaflet-groupedlayercontrol";
import "./../style/leaflet.groupedlayercontrol.css";

// Power BI
import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.extensibility.ISelectionId;

// For reading tabular data
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;

import "./../style/visual.less";

let i = 0;
var bounds;

export class Visual implements IVisual {
  private target!: HTMLElement;
  private map!: L.Map;
  private inited = false;
  private selectionManager: ISelectionManager;
  private host: powerbi.extensibility.visual.IVisualHost;

  // Basemaps
  private darkMap!: L.TileLayer;
  private greymap!: L.TileLayer;
  private lightMap!: L.TileLayer;
  private arcMap!: L.TileLayer;

  // Overlays
  private saonesLayer!: EsriFeatureLayer;
  private layerControl?: L.Control.Layers;
  private legend?: L.Control;
  private fglayer?: L.FeatureGroup;

  // Work zone layers
  private saones: string[] = [];
  private cands: string[] = [];
  
  // Store the mapping between SA1 codes and scores
  private scoreMap: Map<string, number> = new Map();
  
  // Store the mapping between SA1 codes and selection IDs
  private selectionIdMap: Map<string, ISelectionId> = new Map();
  
  // Store min/max for legend
  private minScore: number = 0;
  private maxScore: number = 100;

  private autoRefreshTimer: number | null = null;

  constructor(options: VisualConstructorOptions | undefined) {
    this.target = options?.element!;
    this.host = options?.host!;
    this.selectionManager = this.host.createSelectionManager();
    
    this.createMapContainer();
    this.initMap();
  }

  public update(options: VisualUpdateOptions): void {
    if (!this.inited) {
      this.inited = true;
      requestAnimationFrame(() => this.initLayersAndUI());
    }

    requestAnimationFrame(() => this.map.invalidateSize());

    const dataView: DataView | undefined = options.dataViews && options.dataViews[0];
    if (!dataView || !dataView.categorical) {
      console.log("No data");
      return;
    }

    const categorical = dataView.categorical;

    if (!categorical.categories || categorical.categories.length < 1) {
      console.log("Not enough categories");
      return;
    }

    const saones = categorical.categories[0].values;
    const cands = categorical.categories[1].values;
    this.cands = cands as string[];
    this.saones = saones.map((code: any) => String(code));

    // Get scores and create the mapping
    if (categorical.values && categorical.values.length > 0) {
      const scores = categorical.values[0].values;
      
      this.scoreMap.clear();
      this.selectionIdMap.clear();
      
      // Store scores and selection IDs
      for (let i = 0; i < this.saones.length; i++) {
        const sa1Code = this.saones[i];
        const score = scores[i] as number;
        this.scoreMap.set(sa1Code, score);
        
        // Create selection ID for this data point
        const selectionId = this.host.createSelectionIdBuilder()
          .withCategory(categorical.categories[0], i)
          .createSelectionId();
        this.selectionIdMap.set(sa1Code, selectionId);
      }
      
      console.log(`Scores stored (expecting 0-1 range)`);
    }

    // Refresh the layer with new data
    if (this.inited && this.saones.length > 0) {
      this.updateSaonesLayer();
      this.updateLegend();
    }
  }

  public destroy(): void {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    document.removeEventListener("visibilitychange", this.onVisibilityRefresh);
    if (this.legend) {
      try {
        this.map.removeControl(this.legend);
      } catch (e) {
        // Legend might already be removed
      }
    }
    this.map.remove();
  }

  // ---------------- internals ----------------

  private createMapContainer() {
    const existing = document.getElementById("mapid");
    if (existing) existing.remove();
    const div = document.createElement("div");
    div.id = "mapid";
    div.style.width = "100%";
    div.style.height = "100%";
    this.target.appendChild(div);
  }

  private initMap() {
    this.map = L.map("mapid", { center: [-35.36, 149.23], zoom: 7, maxZoom: 20, minZoom: 3 });

    this.map.createPane("saones");
    this.map.getPane("saones")!.style.zIndex = "400";

    this.map.createPane("workzones");
    this.map.getPane("workzones")!.style.zIndex = "450";

    this.darkMap = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 20
    });

    this.greymap = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(this.map);

    this.lightMap = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });

    this.arcMap = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20,
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012'
    }); 
  }

  private initLayersAndUI() {
    // -------- Layer control --------
    const baseMaps = {
      "Dark Basemap": this.darkMap,
      "Light Basemap": this.lightMap,
      "ArcGIS Basemap": this.arcMap,
      "Carto Positron Grey": this.greymap
    };

    const groupedOverlays: Record<string, Record<string, L.Layer>> = {
      "Boundaries": {}
    };

    // @ts-ignore
    this.layerControl = (L as any).control
      .groupedLayers(baseMaps, groupedOverlays, {
        collapsed: false,
        exclusiveGroups: ["Boundaries"],
        groupCheckboxes: false
      })
      .addTo(this.map) as L.Control.Layers;

    this.addLegend();

    this.startAutoRefresh(6 * 60 * 60 * 1000);
    document.addEventListener("visibilitychange", this.onVisibilityRefresh);
    
    if (this.saones.length > 0) {
      this.updateSaonesLayer();
    }
  }

  private getColorByScore(score: number): string {
    const normalized = Math.max(0, Math.min(1, score));
    const index = Math.floor(normalized * 10);
    const clampedIndex = Math.max(0, Math.min(9, index));
    
    const colors = [
      "#FF0000", "#FF3800", "#FF7000", "#FFA800", "#FFE000",
      "#E0FF00", "#A8FF00", "#70FF00", "#38FF00", "#00FF00"
    ];
    
    return colors[clampedIndex];
  }

  private addLegend() {
    const legend = new (L.Control.extend({
      options: { position: 'bottomright' }
    }))();

    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'info legend');
      div.style.backgroundColor = 'white';
      div.style.padding = '5px';
      div.style.borderRadius = '5px';
      div.style.fontSize = '12px';
      div.style.lineHeight = '20px';
      div.style.minWidth = '80px';  
      div.style.width = 'auto';
      
      div.innerHTML = '<strong>Percent of Votes</strong><br>';
      
      const step = 1.0 / 10;
      
      for (let i = 0; i < 10; i++) {
        const from = step * i;
        const to = step * (i + 1);
        const color = this.getColorByScore(from + step / 2);
        
        const fromPercent = (from * 100).toFixed(0);
        const toPercent = (to * 100).toFixed(0);
        
        div.innerHTML +=
          `<i style="background:${color}; width: 12px; height: 12px; float: left; margin-right: 8px; opacity: 0.7; border: 1px solid #ccc;"></i> ` +
          `${fromPercent}%${i === 9 ? '+' : '–' + toPercent + '%'}<br>`;
      }
      
      return div;
    };

    legend.addTo(this.map);
    this.legend = legend;
  }

  private updateLegend() {
    if (!this.legend) {
      this.addLegend();
    }
  }

  private updateSaonesLayer() {
    if (this.fglayer) {
      if (this.map.hasLayer(this.fglayer)) {
        this.fglayer.clearLayers();
      }
    } else {
      this.fglayer = L.featureGroup().addTo(this.map);
      if (this.layerControl && this.fglayer) {
        this.layerControl.addOverlay(this.fglayer, "SA1 Boundaries");
      }
    }

    const tims = "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SA1/FeatureServer/0";
    
    const workzoneLinePolyStyle = (feature: any): L.PathOptions => {
      const sa1Code = feature.properties.sa1_code_2021 || feature.properties.SA1_CODE_2021;
      const score = this.scoreMap.get(String(sa1Code));
      
      let fillColor = "#cccccc";
      if (score !== undefined) {
        fillColor = this.getColorByScore(score);
      }
      
      return {
        pane: "workzones",
        interactive: true,
        weight: 0.6,
        color: "#333333",
        opacity: 0.8,
        fillColor: fillColor,
        fillOpacity: 0.7
      };
    };

    const workzoneEachFeature = (feature: any, layer: L.Layer) => {
      const sa1Code = feature.properties.sa1_code_2021 || feature.properties.SA1_CODE_2021;
      const score = this.scoreMap.get(String(sa1Code));
      const selectionId = this.selectionIdMap.get(String(sa1Code));
      
      const label = `<strong>SA1 Code:</strong> ${sa1Code}<br/>${this.cands[0]}<br>
                     <strong>Score:</strong> ${score !== undefined ? ((score * 100.0).toFixed(2)) : "No data"}%`;
      
      (layer as L.Path).bindTooltip(label, { sticky: true });
      
      // Add click handler for selection
      layer.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        
        if (selectionId) {
          // Handle Ctrl+Click for multi-select
          const multiSelect = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
          this.selectionManager.select(selectionId, multiSelect);
          console.log("Selected SA1:", sa1Code);
        }
      });
      
      layer.on("mouseover", () => {
        (layer as L.Path).setStyle({ 
          color: "#000000",
          weight: 2
        });
      });
      
      layer.on("mouseout", () => {
        (layer as L.Path).setStyle({ 
          color: "#333333",
          weight: 0.6
        });
      });
    };

    const sa1s = this.saones.map((code: string) => `'${code}'`).join(',');

    this.saonesLayer = LEsri.featureLayer({
      url: tims,
      where: `sa1_code_2021 IN (${sa1s})`,
      pane: "workzones",
      style: workzoneLinePolyStyle,
      onEachFeature: workzoneEachFeature
    }).addTo(this.fglayer);



    this.saonesLayer.refresh();
  }

  private onVisibilityRefresh = () => {
    if (document.visibilityState === "visible") this.refreshAllLayers();
  };

  private startAutoRefresh(ms: number) {
    if (this.autoRefreshTimer) clearInterval(this.autoRefreshTimer);
    if (ms > 0) this.autoRefreshTimer = window.setInterval(() => this.refreshAllLayers(), ms);
  }

  private refreshAllLayers() {
    const layers = [this.saonesLayer];
    for (const l of layers) {
      if (l) {
        (l as any)?.refresh?.();
      }
    }
  }
}