// Proves, under tsc, every type-only export docs/upgrading.md names as what an
// application writes now, and every member a row checks with `Name#member`.
// rust-rewrite/compat/upgrade-guide.test.ts checks that this file covers the
// guide and runs tsc on it (rust-rewrite/compat/tsconfig.json). When a row
// changes, the test names the line to add here.

import type { ActivationPolicy as ActivationPolicy__sweetview } from "@n1h/sweetview";
import type { ActivationPolicy as ActivationPolicy__sweetview__native } from "@n1h/sweetview/native";
import type { ActivationPolicy as ActivationPolicy__sweetview_native } from "@n1h/sweetview-native";
import type { AnyEvent as AnyEvent__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { AnyEvent as AnyEvent__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { App as App__sweetview } from "@n1h/sweetview";
import type { AppIdentity as AppIdentity__sweetview } from "@n1h/sweetview";
import type { AppIdentity as AppIdentity__sweetview__build } from "@n1h/sweetview/build";
import type { AppIdentity as AppIdentity__sweetview__native } from "@n1h/sweetview/native";
import type { AppIdentity as AppIdentity__sweetview_build } from "@n1h/sweetview-build";
import type { AppIdentity as AppIdentity__sweetview_native } from "@n1h/sweetview-native";
import type { AppIdentity as AppIdentity__sweetview_settings } from "@n1h/sweetview-settings";
import type { AppIdentity as AppIdentity__sweetview_settings__app_identity } from "@n1h/sweetview-settings/app-identity";
import type { AppIdentityIcon as AppIdentityIcon__sweetview_settings } from "@n1h/sweetview-settings";
import type { AppIdentityIcon as AppIdentityIcon__sweetview_settings__app_identity } from "@n1h/sweetview-settings/app-identity";
import type { AppIdentityInput as AppIdentityInput__sweetview } from "@n1h/sweetview";
import type { AppIdentityInput as AppIdentityInput__sweetview__build } from "@n1h/sweetview/build";
import type { AppIdentityInput as AppIdentityInput__sweetview__native } from "@n1h/sweetview/native";
import type { AppIdentityInput as AppIdentityInput__sweetview_build } from "@n1h/sweetview-build";
import type { AppIdentityInput as AppIdentityInput__sweetview_native } from "@n1h/sweetview-native";
import type { AppIdentityInput as AppIdentityInput__sweetview_settings } from "@n1h/sweetview-settings";
import type { AppIdentityInput as AppIdentityInput__sweetview_settings__app_identity } from "@n1h/sweetview-settings/app-identity";
import type { AppMenuOptions as AppMenuOptions__sweetview__native } from "@n1h/sweetview/native";
import type { AppMenuOptions as AppMenuOptions__sweetview_native } from "@n1h/sweetview-native";
import type { AppOptions as AppOptions__sweetview } from "@n1h/sweetview";
import type { Appearance as Appearance__sweetview__native } from "@n1h/sweetview/native";
import type { Appearance as Appearance__sweetview_native } from "@n1h/sweetview-native";
import type { Asset as Asset__sweetview } from "@n1h/sweetview";
import type { Bridge as Bridge__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Bridge as Bridge__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { CallFrame as CallFrame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { CallFrame as CallFrame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { ChunkFrame as ChunkFrame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { ChunkFrame as ChunkFrame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { CocoaRect as CocoaRect__sweetview_native__darwin__screen } from "@n1h/sweetview-native/darwin/screen";
import type { Ctx as Ctx__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Ctx as Ctx__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { DarwinTabGroupController as DarwinTabGroupController__sweetview_native__darwin__window } from "@n1h/sweetview-native/darwin/window";
import type { DecodedPng as DecodedPng__sweetview__native } from "@n1h/sweetview/native";
import type { DecodedPng as DecodedPng__sweetview_native } from "@n1h/sweetview-native";
import type { DotIconOptions as DotIconOptions__sweetview__native } from "@n1h/sweetview/native";
import type { DotIconOptions as DotIconOptions__sweetview_native } from "@n1h/sweetview-native";
import type { Emit as Emit__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Emit as Emit__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { EventFrame as EventFrame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { EventFrame as EventFrame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { EventLoopOptions as EventLoopOptions__sweetview } from "@n1h/sweetview";
import type { EventLoopOptions as EventLoopOptions__sweetview__native } from "@n1h/sweetview/native";
import type { EventLoopOptions as EventLoopOptions__sweetview_native } from "@n1h/sweetview-native";
import type { EventMap as EventMap__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { EventMap as EventMap__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { FileDropHandler as FileDropHandler__sweetview_native } from "@n1h/sweetview-native";
import type { Frame as Frame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Frame as Frame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { Handlers as Handlers__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Handlers as Handlers__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { HitPolygon as HitPolygon__sweetview__native } from "@n1h/sweetview/native";
import type { HitPolygon as HitPolygon__sweetview__native__hit_regions } from "@n1h/sweetview/native/hit-regions";
import type { HitPolygon as HitPolygon__sweetview_native } from "@n1h/sweetview-native";
import type { HitPolygon as HitPolygon__sweetview_native__hit_regions } from "@n1h/sweetview-native/hit-regions";
import type { HitProbe as HitProbe__sweetview__native } from "@n1h/sweetview/native";
import type { HitProbe as HitProbe__sweetview__native__hit_regions } from "@n1h/sweetview/native/hit-regions";
import type { HitProbe as HitProbe__sweetview_native } from "@n1h/sweetview-native";
import type { HitProbe as HitProbe__sweetview_native__hit_regions } from "@n1h/sweetview-native/hit-regions";
import type { HitRefiner as HitRefiner__sweetview__native } from "@n1h/sweetview/native";
import type { HitRefiner as HitRefiner__sweetview_native } from "@n1h/sweetview-native";
import type { HitRelay as HitRelay__sweetview__native } from "@n1h/sweetview/native";
import type { HostServiceOptions as HostServiceOptions__sweetview__worker } from "@n1h/sweetview/worker";
import type { Icon as Icon__sweetview__native } from "@n1h/sweetview/native";
import type { Icon as Icon__sweetview_native } from "@n1h/sweetview-native";
import type { Id as Id__sweetview_native__darwin__objc } from "@n1h/sweetview-native/darwin/objc";
import type { IndexHtmlOptions as IndexHtmlOptions__sweetview } from "@n1h/sweetview";
import type { KeyHandler as KeyHandler__sweetview__native } from "@n1h/sweetview/native";
import type { KeyHandler as KeyHandler__sweetview_native } from "@n1h/sweetview-native";
import type { KeyMessage as KeyMessage__sweetview__native } from "@n1h/sweetview/native";
import type { KeyMessage as KeyMessage__sweetview_native } from "@n1h/sweetview-native";
import type { KeyboardHook as KeyboardHook__sweetview__native } from "@n1h/sweetview/native";
import type { KeyboardHook as KeyboardHook__sweetview_native } from "@n1h/sweetview-native";
import type { MacAppOptions as MacAppOptions__sweetview__build } from "@n1h/sweetview/build";
import type { MacAppOptions as MacAppOptions__sweetview_build } from "@n1h/sweetview-build";
import type { MenuItem as MenuItem__sweetview__native } from "@n1h/sweetview/native";
import type { MenuItem as MenuItem__sweetview_native } from "@n1h/sweetview-native";
import type { MenuSource as MenuSource__sweetview__native } from "@n1h/sweetview/native";
import type { MenuSource as MenuSource__sweetview_native } from "@n1h/sweetview-native";
import type { MenuTemplate as MenuTemplate__sweetview__native } from "@n1h/sweetview/native";
import type { MenuTemplate as MenuTemplate__sweetview_native } from "@n1h/sweetview-native";
import type { MethodMap as MethodMap__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { MethodMap as MethodMap__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { Modifiers as Modifiers__sweetview__native } from "@n1h/sweetview/native";
import type { Modifiers as Modifiers__sweetview_native } from "@n1h/sweetview-native";
import type { MouseHandler as MouseHandler__sweetview__native } from "@n1h/sweetview/native";
import type { MouseHandler as MouseHandler__sweetview_native } from "@n1h/sweetview-native";
import type { MouseHook as MouseHook__sweetview__native } from "@n1h/sweetview/native";
import type { MouseHook as MouseHook__sweetview_native } from "@n1h/sweetview-native";
import type { MouseMessage as MouseMessage__sweetview__native } from "@n1h/sweetview/native";
import type { MouseMessage as MouseMessage__sweetview_native } from "@n1h/sweetview-native";
import type { NativeRequest as NativeRequest__sweetview } from "@n1h/sweetview";
import type { NativeResponse as NativeResponse__sweetview } from "@n1h/sweetview";
import type { NotificationClick as NotificationClick__sweetview__native } from "@n1h/sweetview/native";
import type { NotificationClick as NotificationClick__sweetview_native } from "@n1h/sweetview-native";
import type { NotificationOptions as NotificationOptions__sweetview__native } from "@n1h/sweetview/native";
import type { NotificationOptions as NotificationOptions__sweetview_native } from "@n1h/sweetview-native";
import type { Notifier as Notifier__sweetview__native } from "@n1h/sweetview/native";
import type { NotifierOptions as NotifierOptions__sweetview__native } from "@n1h/sweetview/native";
import type { NotifierOptions as NotifierOptions__sweetview_native } from "@n1h/sweetview-native";
import type { PermissionStatus as PermissionStatus__sweetview__native } from "@n1h/sweetview/native";
import type { PermissionStatus as PermissionStatus__sweetview_native } from "@n1h/sweetview-native";
import type { Point as Point__sweetview__native } from "@n1h/sweetview/native";
import type { Point as Point__sweetview_native } from "@n1h/sweetview-native";
import type { RawWebview as RawWebview__sweetview } from "@n1h/sweetview";
import type { Rect as Rect__sweetview__native } from "@n1h/sweetview/native";
import type { Rect as Rect__sweetview_native } from "@n1h/sweetview-native";
import type { RegisterUrlSchemeOptions as RegisterUrlSchemeOptions__sweetview } from "@n1h/sweetview";
import type { RegisterUrlSchemeOptions as RegisterUrlSchemeOptions__sweetview__native } from "@n1h/sweetview/native";
import type { RegisterUrlSchemeOptions as RegisterUrlSchemeOptions__sweetview_native } from "@n1h/sweetview-native";
import type { ReplyFrame as ReplyFrame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { ReplyFrame as ReplyFrame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { RequestHandler as RequestHandler__sweetview__worker } from "@n1h/sweetview/worker";
import type { RequestHandler as RequestHandler__sweetview_native } from "@n1h/sweetview-native";
import type { ResizeEdge as ResizeEdge__sweetview__native } from "@n1h/sweetview/native";
import type { ResizeEdge as ResizeEdge__sweetview_native } from "@n1h/sweetview-native";
import type { ResizeHandle as ResizeHandle__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { ScreenInfo as ScreenInfo__sweetview__native } from "@n1h/sweetview/native";
import type { ScreenInfo as ScreenInfo__sweetview_native } from "@n1h/sweetview-native";
import type { SecondInstanceEvent as SecondInstanceEvent__sweetview } from "@n1h/sweetview";
import type { SecondInstanceEvent as SecondInstanceEvent__sweetview__native } from "@n1h/sweetview/native";
import type { SecondInstanceEvent as SecondInstanceEvent__sweetview_native } from "@n1h/sweetview-native";
import type { Service as Service__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Service as Service__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { ServiceDefinition as ServiceDefinition__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { ServiceDefinition as ServiceDefinition__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { Session as Session__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Session as Session__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { SessionKind as SessionKind__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { SessionKind as SessionKind__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { SettingsStoreOptions as SettingsStoreOptions__sweetview__settings_store } from "@n1h/sweetview/settings-store";
import type { SettingsStoreOptions as SettingsStoreOptions__sweetview_settings } from "@n1h/sweetview-settings";
import type { SettingsStoreOptions as SettingsStoreOptions__sweetview_settings__settings_store } from "@n1h/sweetview-settings/settings-store";
import type { SingleInstanceLock as SingleInstanceLock__sweetview } from "@n1h/sweetview";
import type { SingleInstanceLock as SingleInstanceLock__sweetview__native } from "@n1h/sweetview/native";
import type { SingleInstanceLock as SingleInstanceLock__sweetview_native } from "@n1h/sweetview-native";
import type { SingleInstanceOptions as SingleInstanceOptions__sweetview } from "@n1h/sweetview";
import type { SingleInstanceOptions as SingleInstanceOptions__sweetview__native } from "@n1h/sweetview/native";
import type { SingleInstanceOptions as SingleInstanceOptions__sweetview_native } from "@n1h/sweetview-native";
import type { Size as Size__sweetview__native } from "@n1h/sweetview/native";
import type { Size as Size__sweetview_native } from "@n1h/sweetview-native";
import type { Tab as Tab__sweetview } from "@n1h/sweetview";
import type { TabHandle as TabHandle__sweetview__native } from "@n1h/sweetview/native";
import type { TabHandle as TabHandle__sweetview_native } from "@n1h/sweetview-native";
import type { TabOptions as TabOptions__sweetview } from "@n1h/sweetview";
import type { TargetMethod as TargetMethod__sweetview_native__darwin__objc } from "@n1h/sweetview-native/darwin/objc";
import type { Transport as Transport__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { Transport as Transport__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { TransportKind as TransportKind__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { TransportKind as TransportKind__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { TrayIcon as TrayIcon__sweetview__native } from "@n1h/sweetview/native";
import type { TrayIcon as TrayIcon__sweetview_native } from "@n1h/sweetview-native";
import type { TrayOptions as TrayOptions__sweetview__native } from "@n1h/sweetview/native";
import type { TrayOptions as TrayOptions__sweetview_native } from "@n1h/sweetview-native";
import type { UiMethods as UiMethods__sweetview } from "@n1h/sweetview";
import type { WebViewOptions as WebViewOptions__sweetview } from "@n1h/sweetview";
import type { Webview as Webview__sweetview_native } from "@n1h/sweetview-native";
import type { WebviewRequest as WebviewRequest__sweetview_native } from "@n1h/sweetview-native";
import type { WebviewResponse as WebviewResponse__sweetview_native } from "@n1h/sweetview-native";
import type { WebviewResponseHead as WebviewResponseHead__sweetview_native } from "@n1h/sweetview-native";
import type { Window as Window__sweetview__native } from "@n1h/sweetview/native";
import type { Window as Window__sweetview_native } from "@n1h/sweetview-native";
import type { WindowChromeControls as WindowChromeControls__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowChromeInfo as WindowChromeInfo__sweetview } from "@n1h/sweetview";
import type { WindowChromeInfo as WindowChromeInfo__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowChromeKind as WindowChromeKind__sweetview } from "@n1h/sweetview";
import type { WindowChromeKind as WindowChromeKind__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowChromeMethodTable as WindowChromeMethodTable__sweetview } from "@n1h/sweetview";
import type { WindowChromeMethodTable as WindowChromeMethodTable__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowChromeMethods as WindowChromeMethods__sweetview } from "@n1h/sweetview";
import type { WindowChromeMethods as WindowChromeMethods__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowChromeOptions as WindowChromeOptions__sweetview } from "@n1h/sweetview";
import type { WindowChromeOptions as WindowChromeOptions__sweetview__window_chrome } from "@n1h/sweetview/window-chrome";
import type { WindowHandle as WindowHandle__sweetview__native } from "@n1h/sweetview/native";
import type { WindowHandle as WindowHandle__sweetview_native } from "@n1h/sweetview-native";
import type { WindowOptions as WindowOptions__sweetview__native } from "@n1h/sweetview/native";
import type { WindowOptions as WindowOptions__sweetview_native } from "@n1h/sweetview-native";
import type { WindowTabs as WindowTabs__sweetview_native__darwin__tabs } from "@n1h/sweetview-native/darwin/tabs";
import type { WindowTabsOptions as WindowTabsOptions__sweetview_native__darwin__tabs } from "@n1h/sweetview-native/darwin/tabs";
import type { WireFrame as WireFrame__sweetview__ipc } from "@n1h/sweetview/ipc";
import type { WireFrame as WireFrame__sweetview_ipc } from "@n1h/sweetview-ipc";
import type { WsData as WsData__sweetview__ipc_ws } from "@n1h/sweetview/ipc-ws";
import type { WsData as WsData__sweetview__ipc_ws__server } from "@n1h/sweetview/ipc-ws/server";
import type { WsData as WsData__sweetview_ipc_ws } from "@n1h/sweetview-ipc-ws";
import type { WsData as WsData__sweetview_ipc_ws__server } from "@n1h/sweetview-ipc-ws/server";
import type { WsHost as WsHost__sweetview__ipc_ws } from "@n1h/sweetview/ipc-ws";
import type { WsHost as WsHost__sweetview__ipc_ws__server } from "@n1h/sweetview/ipc-ws/server";
import type { WsHost as WsHost__sweetview_ipc_ws } from "@n1h/sweetview-ipc-ws";
import type { WsHost as WsHost__sweetview_ipc_ws__server } from "@n1h/sweetview-ipc-ws/server";
import type { WsHostOptions as WsHostOptions__sweetview__ipc_ws } from "@n1h/sweetview/ipc-ws";
import type { WsHostOptions as WsHostOptions__sweetview__ipc_ws__server } from "@n1h/sweetview/ipc-ws/server";
import type { WsHostOptions as WsHostOptions__sweetview_ipc_ws } from "@n1h/sweetview-ipc-ws";
import type { WsHostOptions as WsHostOptions__sweetview_ipc_ws__server } from "@n1h/sweetview-ipc-ws/server";
import type { WsTransport as WsTransport__sweetview__ipc_ws } from "@n1h/sweetview/ipc-ws";
import type { WsTransport as WsTransport__sweetview__ipc_ws__client } from "@n1h/sweetview/ipc-ws/client";
import type { WsTransport as WsTransport__sweetview_ipc_ws } from "@n1h/sweetview-ipc-ws";
import type { WsTransport as WsTransport__sweetview_ipc_ws__client } from "@n1h/sweetview-ipc-ws/client";

export type AppOptions__sweetview_bounds = AppOptions__sweetview["bounds"];
export type AppOptions__sweetview_contentSize = AppOptions__sweetview["contentSize"];
export type AppOptions__sweetview_resizable = AppOptions__sweetview["resizable"];
export type AppOptions__sweetview_transparent = AppOptions__sweetview["transparent"];
export type App__sweetview_dispose = App__sweetview["dispose"];
export type App__sweetview_emit = App__sweetview["emit"];
export type App__sweetview_notify = App__sweetview["notify"];
export type App__sweetview_onEvent = App__sweetview["onEvent"];
export type App__sweetview_quit = App__sweetview["quit"];
export type App__sweetview_run = App__sweetview["run"];
export type App__sweetview_webview = App__sweetview["webview"];
export type App__sweetview_window = App__sweetview["window"];
export type HitRelay__sweetview__native_answer = HitRelay__sweetview__native["answer"];
export type HitRelay__sweetview__native_apply = HitRelay__sweetview__native["apply"];
export type HitRelay__sweetview__native_isEnabled = HitRelay__sweetview__native["isEnabled"];
export type HitRelay__sweetview__native_setEnabled = HitRelay__sweetview__native["setEnabled"];
export type HitRelay__sweetview__native_setRegions = HitRelay__sweetview__native["setRegions"];
export type NotifierOptions__sweetview__native_onClick = NotifierOptions__sweetview__native["onClick"];
export type Notifier__sweetview__native_notify = Notifier__sweetview__native["notify"];
export type RawWebview__sweetview_beginResponse = RawWebview__sweetview["beginResponse"];
export type RawWebview__sweetview_setAllowExternalDrop = RawWebview__sweetview["setAllowExternalDrop"];
export type RawWebview__sweetview_setAsset = RawWebview__sweetview["setAsset"];
export type RawWebview__sweetview_setBackgroundColor = RawWebview__sweetview["setBackgroundColor"];
export type RawWebview__sweetview_setFileDropHandler = RawWebview__sweetview["setFileDropHandler"];
export type RawWebview__sweetview_setRequestHandler = RawWebview__sweetview["setRequestHandler"];
export type Webview__sweetview_native_bindRaw = Webview__sweetview_native["bindRaw"];
export type Webview__sweetview_native_unsafeHandle = Webview__sweetview_native["unsafeHandle"];
export type Webview__sweetview_native_unsafeWindowHandle = Webview__sweetview_native["unsafeWindowHandle"];
export type WindowChromeOptions__sweetview__window_chrome_onClose = WindowChromeOptions__sweetview__window_chrome["onClose"];
export type WindowOptions__sweetview__native_appearance = WindowOptions__sweetview__native["appearance"];
export type WindowOptions__sweetview__native_frame = WindowOptions__sweetview__native["frame"];
export type WindowOptions__sweetview__native_hideFromTaskbar = WindowOptions__sweetview__native["hideFromTaskbar"];
export type WindowOptions__sweetview__native_noActivate = WindowOptions__sweetview__native["noActivate"];
export type WindowOptions__sweetview__native_topmost = WindowOptions__sweetview__native["topmost"];
export type WindowOptions__sweetview_native_onClose = WindowOptions__sweetview_native["onClose"];
export type WindowOptions__sweetview_native_onMove = WindowOptions__sweetview_native["onMove"];
export type WindowOptions__sweetview_native_onResize = WindowOptions__sweetview_native["onResize"];
export type WindowOptions__sweetview_native_tabs = WindowOptions__sweetview_native["tabs"];
export type Window__sweetview__native_bounds = Window__sweetview__native["bounds"];
export type Window__sweetview__native_handle = Window__sweetview__native["handle"];
export type Window__sweetview__native_hide = Window__sweetview__native["hide"];
export type Window__sweetview__native_isMaximized = Window__sweetview__native["isMaximized"];
export type Window__sweetview__native_isVisible = Window__sweetview__native["isVisible"];
export type Window__sweetview__native_minimize = Window__sweetview__native["minimize"];
export type Window__sweetview__native_moveTo = Window__sweetview__native["moveTo"];
export type Window__sweetview__native_onClose = Window__sweetview__native["onClose"];
export type Window__sweetview__native_resize = Window__sweetview__native["resize"];
export type Window__sweetview__native_scale = Window__sweetview__native["scale"];
export type Window__sweetview__native_setBounds = Window__sweetview__native["setBounds"];
export type Window__sweetview__native_setClickThrough = Window__sweetview__native["setClickThrough"];
export type Window__sweetview__native_setHitRegions = Window__sweetview__native["setHitRegions"];
export type Window__sweetview__native_setIcon = Window__sweetview__native["setIcon"];
export type Window__sweetview__native_setTopmost = Window__sweetview__native["setTopmost"];
export type Window__sweetview__native_show = Window__sweetview__native["show"];
export type Window__sweetview__native_startDrag = Window__sweetview__native["startDrag"];
export type Window__sweetview__native_startResize = Window__sweetview__native["startResize"];
export type Window__sweetview__native_toggle = Window__sweetview__native["toggle"];
export type Window__sweetview__native_toggleMaximize = Window__sweetview__native["toggleMaximize"];
export type Window__sweetview_native_dispose = Window__sweetview_native["dispose"];
export type Window__sweetview_native_hide = Window__sweetview_native["hide"];
export type Window__sweetview_native_minimize = Window__sweetview_native["minimize"];
export type Window__sweetview_native_moveTo = Window__sweetview_native["moveTo"];
export type Window__sweetview_native_onClose = Window__sweetview_native["onClose"];
export type Window__sweetview_native_onMaximizeChange = Window__sweetview_native["onMaximizeChange"];
export type Window__sweetview_native_showSystemMenu = Window__sweetview_native["showSystemMenu"];
export type Window__sweetview_native_onFileDrop = Window__sweetview_native["onFileDrop"];
export type Window__sweetview_native_onMove = Window__sweetview_native["onMove"];
export type Window__sweetview_native_onResize = Window__sweetview_native["onResize"];
export type Window__sweetview_native_resize = Window__sweetview_native["resize"];
export type Window__sweetview_native_scale = Window__sweetview_native["scale"];
export type Window__sweetview_native_setBounds = Window__sweetview_native["setBounds"];
export type Window__sweetview_native_setClickThrough = Window__sweetview_native["setClickThrough"];
export type Window__sweetview_native_setIcon = Window__sweetview_native["setIcon"];
export type Window__sweetview_native_setTitle = Window__sweetview_native["setTitle"];
export type Window__sweetview_native_setTopmost = Window__sweetview_native["setTopmost"];
export type Window__sweetview_native_show = Window__sweetview_native["show"];
export type Window__sweetview_native_startDrag = Window__sweetview_native["startDrag"];
export type Window__sweetview_native_toggleMaximize = Window__sweetview_native["toggleMaximize"];
export type WsHost__sweetview__ipc_ws_dispose = WsHost__sweetview__ipc_ws["dispose"];
export type WsTransport__sweetview__ipc_ws_dispose = WsTransport__sweetview__ipc_ws["dispose"];
export type Tab__sweetview_window = Tab__sweetview["window"];
export type Webview__sweetview_native_destroy = Webview__sweetview_native["destroy"];

// Types an application declares in its own code (rows whose "Write now" is a declaration).
export type MessageHandler = (message: number, wParam: bigint, lParam: bigint) => void;
export type MessageWindow = { readonly hwnd: bigint; readonly destroy: () => void };

// The types of the rows that say `no public call in 1.0` (D45): no public entry exports them.
// @ts-expect-error no public call in 1.0
import type { Key as NoPublic_Key___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { Key as NoPublic_Key___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { Shortcut as NoPublic_Shortcut___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { Shortcut as NoPublic_Shortcut___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { StripEvents as NoPublic_StripEvents___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { StripEvents as NoPublic_StripEvents___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { StripMethods as NoPublic_StripMethods___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { StripMethods as NoPublic_StripMethods___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { StripPoint as NoPublic_StripPoint___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { StripPoint as NoPublic_StripPoint___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { StripState as NoPublic_StripState___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { StripState as NoPublic_StripState___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { StripTab as NoPublic_StripTab___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { StripTab as NoPublic_StripTab___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { FrameCallbacks as NoPublic_FrameCallbacks___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { FrameCallbacks as NoPublic_FrameCallbacks___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { FrameWindow as NoPublic_FrameWindow___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { FrameWindow as NoPublic_FrameWindow___n1h_sweetview_native } from "@n1h/sweetview-native";

// The macOS types of the rows that say `no public call in 1.0` (D45): no public entry exports them.
// @ts-expect-error no public call in 1.0
import type { Id as NoPublic_Id___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { Id as NoPublic_Id___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { TargetMethod as NoPublic_TargetMethod___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { TargetMethod as NoPublic_TargetMethod___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { CocoaRect as NoPublic_CocoaRect___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { CocoaRect as NoPublic_CocoaRect___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { WindowTabs as NoPublic_WindowTabs___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { WindowTabs as NoPublic_WindowTabs___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { WindowTabsOptions as NoPublic_WindowTabsOptions___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { WindowTabsOptions as NoPublic_WindowTabsOptions___n1h_sweetview_native } from "@n1h/sweetview-native";
// @ts-expect-error no public call in 1.0
import type { DarwinTabGroupController as NoPublic_DarwinTabGroupController___n1h_sweetview } from "@n1h/sweetview";
// @ts-expect-error no public call in 1.0
import type { DarwinTabGroupController as NoPublic_DarwinTabGroupController___n1h_sweetview_native } from "@n1h/sweetview-native";
export type Window__sweetview_native_handle = Window__sweetview_native["handle"];
export type Window__sweetview_native_startResize = Window__sweetview_native["startResize"];
