declare module "blessed-contrib" {
  import type { Widgets } from "blessed";

  interface GridOptions {
    rows: number;
    cols: number;
    screen: Widgets.Screen;
  }

  interface GaugeOptions {
    label?: string;
    stroke?: string;
    fill?: string;
    width?: string | number;
    height?: string | number;
    top?: string | number;
    left?: string | number;
    tags?: boolean;
    border?: { type: string; fg?: string };
    style?: Record<string, unknown>;
  }

  interface BarOptions {
    label?: string;
    barWidth?: number;
    barSpacing?: number;
    xOffset?: number;
    maxHeight?: number;
    width?: string | number;
    height?: string | number;
    top?: string | number;
    left?: string | number;
    tags?: boolean;
    border?: { type: string; fg?: string };
    style?: Record<string, unknown>;
    fg?: string;
    barBgColor?: string;
    labelColor?: string;
  }

  interface LogOptions {
    fg?: string;
    label?: string;
    tags?: boolean;
    width?: string | number;
    height?: string | number;
    top?: string | number;
    left?: string | number;
    border?: { type: string; fg?: string };
    style?: Record<string, unknown>;
    scrollable?: boolean;
    mouse?: boolean;
  }

  interface DonutOptions {
    label?: string;
    radius?: number;
    arcWidth?: number;
    remainColor?: string;
    yPadding?: number;
    width?: string | number;
    height?: string | number;
    top?: string | number;
    left?: string | number;
    tags?: boolean;
    border?: { type: string; fg?: string };
    style?: Record<string, unknown>;
    data?: Array<{ percent: number; label: string; color: string }>;
  }

  interface GaugeWidget extends Widgets.BlessedElement {
    setPercent(percent: number): void;
    setStack(stack: Array<{ percent: number; stroke: string }>): void;
    update(percent: number): void;
  }

  interface BarWidget extends Widgets.BlessedElement {
    setData(data: { titles: string[]; data: number[] }): void;
  }

  interface LogWidget extends Widgets.BlessedElement {
    log(text: string): void;
    add(text: string): void;
    setContent(text: string): void;
  }

  interface DonutWidget extends Widgets.BlessedElement {
    setData(data: Array<{ percent: number; label: string; color: string }>): void;
  }

  class grid {
    constructor(opts: GridOptions);
    set<T extends Widgets.BlessedElement>(
      row: number,
      col: number,
      rowSpan: number,
      colSpan: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      widget: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any,
    ): T;
  }

  function gauge(options?: GaugeOptions): GaugeWidget;
  function bar(options?: BarOptions): BarWidget;
  function log(options?: LogOptions): LogWidget;
  function donut(options?: DonutOptions): DonutWidget;
}
