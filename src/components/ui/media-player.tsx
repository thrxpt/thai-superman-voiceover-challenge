"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import { Slot } from "@radix-ui/react-slot";
import {
  AlertTriangleIcon,
  CaptionsOffIcon,
  CheckIcon,
  DownloadIcon,
  FastForwardIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PauseIcon,
  PictureInPicture2Icon,
  PictureInPictureIcon,
  PlayIcon,
  RefreshCcwIcon,
  RepeatIcon,
  RewindIcon,
  RotateCcwIcon,
  SettingsIcon,
  SubtitlesIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import {
  MediaActionTypes,
  MediaProvider,
  timeUtils,
  useMediaDispatch,
  useMediaFullscreenRef,
  useMediaRef,
  useMediaSelector,
} from "media-chrome/react/media-store";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useComposedRefs } from "@/lib/compose-refs";
import { cn } from "@/lib/utils";

const ROOT_NAME = "MediaPlayer";
const SEEK_NAME = "MediaPlayerSeek";
const SETTINGS_NAME = "MediaPlayerSettings";
const VOLUME_NAME = "MediaPlayerVolume";
const PLAYBACK_SPEED_NAME = "MediaPlayerPlaybackSpeed";

const FLOATING_MENU_SIDE_OFFSET = 10;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const SEEK_STEP_SHORT = 5;
const SEEK_STEP_LONG = 10;
const SEEK_COLLISION_PADDING = 10;
const SEEK_TOOLTIP_WIDTH_FALLBACK = 240;

const SEEK_HOVER_PERCENT = "--seek-hover-percent";
const SEEK_TOOLTIP_X = "--seek-tooltip-x";
const SEEK_TOOLTIP_Y = "--seek-tooltip-y";

const SPRITE_CONTAINER_WIDTH = 224;
const SPRITE_CONTAINER_HEIGHT = 128;

type Direction = "ltr" | "rtl";

const DirectionContext = React.createContext<Direction | undefined>(undefined);

function useDirection(dirProp?: Direction): Direction {
  const contextDir = React.useContext(DirectionContext);
  return dirProp ?? contextDir ?? "ltr";
}

function useLazyRef<T>(fn: () => T) {
  const ref = React.useRef<T | null>(null);

  if (ref.current === null) {
    ref.current = fn();
  }

  return ref as React.RefObject<T>;
}

interface StoreState {
  controlsVisible: boolean;
  dragging: boolean;
  menuOpen: boolean;
  volumeIndicatorVisible: boolean;
}

interface Store {
  subscribe: (cb: () => void) => () => void;
  getState: () => StoreState;
  setState: (
    key: keyof StoreState,
    value: StoreState[keyof StoreState]
  ) => void;
  notify: () => void;
}

function createStore(
  listenersRef: React.RefObject<Set<() => void>>,
  stateRef: React.RefObject<StoreState>,
  onValueChange?: Partial<{
    [K in keyof StoreState]: (value: StoreState[K], store: Store) => void;
  }>
): Store {
  const store: Store = {
    subscribe: (cb) => {
      listenersRef.current.add(cb);
      return () => listenersRef.current.delete(cb);
    },
    getState: () => stateRef.current,
    setState: (key, value) => {
      if (Object.is(stateRef.current[key], value)) return;
      stateRef.current[key] = value;
      onValueChange?.[key]?.(value, store);
      store.notify();
    },
    notify: () => {
      for (const cb of listenersRef.current) {
        cb();
      }
    },
  };

  return store;
}

const StoreContext = React.createContext<Store | null>(null);

function useStoreContext(consumerName: string) {
  const context = React.useContext(StoreContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
  }
  return context;
}

function useStoreSelector<U>(selector: (state: StoreState) => U): U {
  const storeContext = useStoreContext("useStoreSelector");

  const getSnapshot = React.useCallback(
    () => selector(storeContext.getState()),
    [storeContext, selector]
  );

  return React.useSyncExternalStore(
    storeContext.subscribe,
    getSnapshot,
    getSnapshot
  );
}

interface MediaPlayerContextValue {
  mediaId: string;
  labelId: string;
  descriptionId: string;
  dir: Direction;
  rootRef: React.RefObject<HTMLDivElement | null>;
  mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement | null>;
  portalContainer: Element | DocumentFragment | null;
  tooltipDelayDuration: number;
  tooltipSideOffset: number;
  disabled: boolean;
  isVideo: boolean;
  withoutTooltip: boolean;
}

const MediaPlayerContext = React.createContext<MediaPlayerContextValue | null>(
  null
);

function useMediaPlayerContext(consumerName: string) {
  const context = React.useContext(MediaPlayerContext);
  if (!context) {
    throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
  }
  return context;
}

interface MediaPlayerRootProps
  extends Omit<React.ComponentProps<"div">, "onTimeUpdate" | "onVolumeChange"> {
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onTimeUpdate?: (time: number) => void;
  onVolumeChange?: (volume: number) => void;
  onMuted?: (muted: boolean) => void;
  onMediaError?: (error: MediaError | null) => void;
  onPipError?: (error: unknown, state: "enter" | "exit") => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
  dir?: Direction;
  label?: string;
  tooltipDelayDuration?: number;
  tooltipSideOffset?: number;
  asChild?: boolean;
  autoHide?: boolean;
  disabled?: boolean;
  withoutTooltip?: boolean;
}

function MediaPlayerRoot(props: MediaPlayerRootProps) {
  const listenersRef = useLazyRef(() => new Set<() => void>());
  const stateRef = useLazyRef<StoreState>(() => ({
    controlsVisible: true,
    dragging: false,
    menuOpen: false,
    volumeIndicatorVisible: false,
  }));

  const store = React.useMemo(
    () => createStore(listenersRef, stateRef),
    [listenersRef, stateRef]
  );

  return (
    <MediaProvider>
      <StoreContext.Provider value={store}>
        <MediaPlayerRootImpl {...props} />
      </StoreContext.Provider>
    </MediaProvider>
  );
}

function MediaPlayerRootImpl(props: MediaPlayerRootProps) {
  const {
    onPlay,
    onPause,
    onEnded,
    onTimeUpdate,
    onFullscreenChange,
    onVolumeChange,
    onMuted,
    onMediaError,
    onPipError,
    dir: dirProp,
    label,
    tooltipDelayDuration = 600,
    tooltipSideOffset = FLOATING_MENU_SIDE_OFFSET,
    asChild,
    autoHide = false,
    disabled = false,
    withoutTooltip = false,
    children,
    className,
    ref,
    ...rootImplProps
  } = props;

  const mediaId = React.useId();
  const labelId = React.useId();
  const descriptionId = React.useId();

  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useMediaFullscreenRef();
  const composedRef = useComposedRefs(ref, rootRef, fullscreenRef);

  const dir = useDirection(dirProp);
  const dispatch = useMediaDispatch();
  const mediaRef = React.useRef<HTMLVideoElement | HTMLAudioElement | null>(
    null
  );

  const store = useStoreContext(ROOT_NAME);

  const controlsVisible = useStoreSelector((state) => state.controlsVisible);
  const dragging = useStoreSelector((state) => state.dragging);
  const menuOpen = useStoreSelector((state) => state.menuOpen);

  const hideControlsTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const lastMouseMoveRef = React.useRef<number>(Date.now());
  const volumeIndicatorTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const mediaPaused = useMediaSelector((state) => state.mediaPaused ?? true);
  const isFullscreen = useMediaSelector(
    (state) => state.mediaIsFullscreen ?? false
  );

  const [mounted, setMounted] = React.useState(false);
  React.useLayoutEffect(() => setMounted(true), []);

  const portalContainer = mounted
    ? isFullscreen
      ? rootRef.current
      : globalThis.document.body
    : null;

  const isVideo =
    (typeof HTMLVideoElement !== "undefined" &&
      mediaRef.current instanceof HTMLVideoElement) ||
    mediaRef.current?.tagName?.toLowerCase() === "mux-player";

  const onControlsShow = React.useCallback(() => {
    store.setState("controlsVisible", true);
    lastMouseMoveRef.current = Date.now();

    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current);
    }

    if (autoHide && !mediaPaused && !menuOpen && !dragging) {
      hideControlsTimeoutRef.current = setTimeout(() => {
        store.setState("controlsVisible", false);
      }, 3000);
    }
  }, [store.setState, autoHide, mediaPaused, menuOpen, dragging]);

  const onVolumeIndicatorTrigger = React.useCallback(() => {
    if (menuOpen) return;

    store.setState("volumeIndicatorVisible", true);

    if (volumeIndicatorTimeoutRef.current) {
      clearTimeout(volumeIndicatorTimeoutRef.current);
    }

    volumeIndicatorTimeoutRef.current = setTimeout(() => {
      store.setState("volumeIndicatorVisible", false);
    }, 2000);

    if (autoHide) {
      onControlsShow();
    }
  }, [store.setState, menuOpen, autoHide, onControlsShow]);

  const onMouseLeave = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      rootImplProps.onMouseLeave?.(event);

      if (event.defaultPrevented) return;

      if (autoHide && !mediaPaused && !menuOpen && !dragging) {
        store.setState("controlsVisible", false);
      }
    },
    [
      store.setState,
      rootImplProps.onMouseLeave,
      autoHide,
      mediaPaused,
      menuOpen,
      dragging,
    ]
  );

  const onMouseMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      rootImplProps.onMouseMove?.(event);

      if (event.defaultPrevented) return;

      if (autoHide) {
        onControlsShow();
      }
    },
    [autoHide, rootImplProps.onMouseMove, onControlsShow]
  );

  React.useEffect(() => {
    if (mediaPaused || menuOpen || dragging) {
      store.setState("controlsVisible", true);
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current);
      }
      return;
    }

    if (autoHide) {
      onControlsShow();
    }
  }, [
    store.setState,
    onControlsShow,
    autoHide,
    menuOpen,
    mediaPaused,
    dragging,
  ]);

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      rootImplProps.onKeyDown?.(event);

      if (event.defaultPrevented) return;

      const mediaElement = mediaRef.current;
      if (!mediaElement) return;

      const isMediaFocused = document.activeElement === mediaElement;
      const isPlayerFocused =
        document.activeElement?.closest('[data-slot="media-player"]') !== null;

      if (!(isMediaFocused || isPlayerFocused)) return;

      if (autoHide) onControlsShow();

      switch (event.key.toLowerCase()) {
        case " ":
        case "k":
          event.preventDefault();
          dispatch({
            type: mediaElement.paused
              ? MediaActionTypes.MEDIA_PLAY_REQUEST
              : MediaActionTypes.MEDIA_PAUSE_REQUEST,
          });
          break;

        case "f":
          event.preventDefault();
          dispatch({
            type: document.fullscreenElement
              ? MediaActionTypes.MEDIA_EXIT_FULLSCREEN_REQUEST
              : MediaActionTypes.MEDIA_ENTER_FULLSCREEN_REQUEST,
          });
          break;

        case "m": {
          event.preventDefault();
          if (isVideo) {
            onVolumeIndicatorTrigger();
          }
          dispatch({
            type: mediaElement.muted
              ? MediaActionTypes.MEDIA_UNMUTE_REQUEST
              : MediaActionTypes.MEDIA_MUTE_REQUEST,
          });
          break;
        }

        case "arrowright":
          event.preventDefault();
          if (
            isVideo ||
            (mediaElement instanceof HTMLAudioElement && event.shiftKey)
          ) {
            dispatch({
              type: MediaActionTypes.MEDIA_SEEK_REQUEST,
              detail: Math.min(
                mediaElement.duration,
                mediaElement.currentTime + SEEK_STEP_SHORT
              ),
            });
          }
          break;

        case "arrowleft":
          event.preventDefault();
          if (
            isVideo ||
            (mediaElement instanceof HTMLAudioElement && event.shiftKey)
          ) {
            dispatch({
              type: MediaActionTypes.MEDIA_SEEK_REQUEST,
              detail: Math.max(0, mediaElement.currentTime - SEEK_STEP_SHORT),
            });
          }
          break;

        case "arrowup":
          event.preventDefault();
          if (isVideo) {
            onVolumeIndicatorTrigger();
            dispatch({
              type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
              detail: Math.min(1, mediaElement.volume + 0.1),
            });
          }
          break;

        case "arrowdown":
          event.preventDefault();
          if (isVideo) {
            onVolumeIndicatorTrigger();
            dispatch({
              type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
              detail: Math.max(0, mediaElement.volume - 0.1),
            });
          }
          break;

        case "<": {
          event.preventDefault();
          const currentRate = mediaElement.playbackRate;
          const currentIndex = SPEEDS.indexOf(currentRate);
          const newIndex = Math.max(0, currentIndex - 1);
          const newRate = SPEEDS[newIndex] ?? 1;
          dispatch({
            type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
            detail: newRate,
          });
          break;
        }

        case ">": {
          event.preventDefault();
          const currentRate = mediaElement.playbackRate;
          const currentIndex = SPEEDS.indexOf(currentRate);
          const newIndex = Math.min(SPEEDS.length - 1, currentIndex + 1);
          const newRate = SPEEDS[newIndex] ?? 1;
          dispatch({
            type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
            detail: newRate,
          });
          break;
        }

        case "c":
          event.preventDefault();
          if (isVideo && mediaElement.textTracks.length > 0) {
            dispatch({
              type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
            });
          }
          break;

        case "d": {
          const hasDownload = mediaElement.querySelector(
            '[data-slot="media-player-download"]'
          );

          if (!hasDownload) break;

          event.preventDefault();
          if (mediaElement.currentSrc) {
            const link = document.createElement("a");
            link.href = mediaElement.currentSrc;
            link.download = "";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }
          break;
        }

        case "p": {
          event.preventDefault();
          if (isVideo && "requestPictureInPicture" in mediaElement) {
            const isPip = document.pictureInPictureElement === mediaElement;
            dispatch({
              type: isPip
                ? MediaActionTypes.MEDIA_EXIT_PIP_REQUEST
                : MediaActionTypes.MEDIA_ENTER_PIP_REQUEST,
            });
            if (isPip) {
              document.exitPictureInPicture().catch((error) => {
                onPipError?.(error, "exit");
              });
            } else {
              mediaElement.requestPictureInPicture().catch((error) => {
                onPipError?.(error, "enter");
              });
            }
          }
          break;
        }

        case "r": {
          event.preventDefault();
          mediaElement.loop = !mediaElement.loop;
          break;
        }

        case "j": {
          event.preventDefault();
          dispatch({
            type: MediaActionTypes.MEDIA_SEEK_REQUEST,
            detail: Math.max(0, mediaElement.currentTime - SEEK_STEP_LONG),
          });
          break;
        }

        case "l": {
          event.preventDefault();
          dispatch({
            type: MediaActionTypes.MEDIA_SEEK_REQUEST,
            detail: Math.min(
              mediaElement.duration,
              mediaElement.currentTime + SEEK_STEP_LONG
            ),
          });
          break;
        }

        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9": {
          event.preventDefault();
          const percent = Number.parseInt(event.key) / 10;
          const seekTime = mediaElement.duration * percent;
          dispatch({
            type: MediaActionTypes.MEDIA_SEEK_REQUEST,
            detail: seekTime,
          });
          break;
        }

        case "home": {
          event.preventDefault();
          dispatch({
            type: MediaActionTypes.MEDIA_SEEK_REQUEST,
            detail: 0,
          });
          break;
        }

        case "end": {
          event.preventDefault();
          dispatch({
            type: MediaActionTypes.MEDIA_SEEK_REQUEST,
            detail: mediaElement.duration,
          });
          break;
        }
      }
    },
    [
      dispatch,
      rootImplProps.onKeyDown,
      onVolumeIndicatorTrigger,
      onPipError,
      disabled,
      isVideo,
      onControlsShow,
      autoHide,
    ]
  );

  const onKeyUp = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      rootImplProps.onKeyUp?.(event);

      const key = event.key.toLowerCase();
      if (key === "arrowup" || key === "arrowdown" || key === "m") {
        onVolumeIndicatorTrigger();
      }
    },
    [rootImplProps.onKeyUp, onVolumeIndicatorTrigger]
  );

  React.useEffect(() => {
    const mediaElement = mediaRef.current;
    if (!mediaElement) return;

    if (onPlay) mediaElement.addEventListener("play", onPlay);
    if (onPause) mediaElement.addEventListener("pause", onPause);
    if (onEnded) mediaElement.addEventListener("ended", onEnded);
    if (onTimeUpdate)
      mediaElement.addEventListener("timeupdate", () =>
        onTimeUpdate?.(mediaElement.currentTime)
      );
    if (onVolumeChange)
      mediaElement.addEventListener("volumechange", () => {
        onVolumeChange?.(mediaElement.volume);
        onMuted?.(mediaElement.muted);
      });
    if (onMediaError)
      mediaElement.addEventListener("error", () =>
        onMediaError?.(mediaElement.error)
      );
    if (onFullscreenChange) {
      document.addEventListener("fullscreenchange", () =>
        onFullscreenChange?.(!!document.fullscreenElement)
      );
    }

    return () => {
      if (onPlay) mediaElement.removeEventListener("play", onPlay);
      if (onPause) mediaElement.removeEventListener("pause", onPause);
      if (onEnded) mediaElement.removeEventListener("ended", onEnded);
      if (onTimeUpdate)
        mediaElement.removeEventListener("timeupdate", () =>
          onTimeUpdate?.(mediaElement.currentTime)
        );
      if (onVolumeChange)
        mediaElement.removeEventListener("volumechange", () => {
          onVolumeChange?.(mediaElement.volume);
          onMuted?.(mediaElement.muted);
        });
      if (onMediaError)
        mediaElement.removeEventListener("error", () =>
          onMediaError?.(mediaElement.error)
        );
      if (onFullscreenChange) {
        document.removeEventListener("fullscreenchange", () =>
          onFullscreenChange?.(!!document.fullscreenElement)
        );
      }
      if (volumeIndicatorTimeoutRef.current) {
        clearTimeout(volumeIndicatorTimeoutRef.current);
      }
      if (hideControlsTimeoutRef.current) {
        clearTimeout(hideControlsTimeoutRef.current);
      }
    };
  }, [
    onPlay,
    onPause,
    onEnded,
    onTimeUpdate,
    onVolumeChange,
    onMuted,
    onMediaError,
    onFullscreenChange,
  ]);

  const contextValue = React.useMemo<MediaPlayerContextValue>(
    () => ({
      mediaId,
      labelId,
      descriptionId,
      dir,
      rootRef,
      mediaRef,
      portalContainer,
      tooltipDelayDuration,
      tooltipSideOffset,
      disabled,
      isVideo,
      withoutTooltip,
    }),
    [
      mediaId,
      labelId,
      descriptionId,
      dir,
      portalContainer,
      tooltipDelayDuration,
      tooltipSideOffset,
      disabled,
      isVideo,
      withoutTooltip,
    ]
  );

  const RootPrimitive = asChild ? Slot : "div";

  return (
    <MediaPlayerContext.Provider value={contextValue}>
      <RootPrimitive
        aria-describedby={descriptionId}
        aria-disabled={disabled}
        aria-labelledby={labelId}
        data-controls-visible={controlsVisible ? "" : undefined}
        data-disabled={disabled ? "" : undefined}
        data-slot="media-player"
        data-state={isFullscreen ? "fullscreen" : "windowed"}
        dir={dir}
        tabIndex={disabled ? undefined : 0}
        {...rootImplProps}
        className={cn(
          "dark relative isolate flex flex-col overflow-hidden rounded-lg bg-background outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_video]:relative [&_video]:object-contain",
          "data-[state=fullscreen]:[&_video]:size-full [:fullscreen_&]:flex [:fullscreen_&]:h-full [:fullscreen_&]:max-h-screen [:fullscreen_&]:flex-col [:fullscreen_&]:justify-between",
          "[&_[data-slider]::before]:-top-4 [&_[data-slider]::before]:-bottom-2 [&_[data-slider]::before]:absolute [&_[data-slider]::before]:inset-x-0 [&_[data-slider]::before]:z-10 [&_[data-slider]::before]:h-8 [&_[data-slider]::before]:cursor-pointer [&_[data-slider]::before]:content-[''] [&_[data-slider]]:relative [&_[data-slot='media-player-seek']:not([data-hovering])::before]:cursor-default",
          "[&_video::-webkit-media-text-track-display]:top-auto! [&_video::-webkit-media-text-track-display]:bottom-[4%]! [&_video::-webkit-media-text-track-display]:mb-0! data-[state=fullscreen]:data-[controls-visible]:[&_video::-webkit-media-text-track-display]:bottom-[9%]! data-[controls-visible]:[&_video::-webkit-media-text-track-display]:bottom-[13%]! data-[state=fullscreen]:[&_video::-webkit-media-text-track-display]:bottom-[7%]!",
          className
        )}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onMouseLeave={onMouseLeave}
        onMouseMove={onMouseMove}
        ref={composedRef}
      >
        <span className="sr-only" id={labelId}>
          {label ?? "Media player"}
        </span>
        <span className="sr-only" id={descriptionId}>
          {isVideo
            ? "Video player with custom controls for playback, volume, seeking, and more. Use space bar to play/pause, arrow keys (←/→) to seek, and arrow keys (↑/↓) to adjust volume."
            : "Audio player with custom controls for playback, volume, seeking, and more. Use space bar to play/pause, Shift + arrow keys (←/→) to seek, and arrow keys (↑/↓) to adjust volume."}
        </span>
        {children}
        <MediaPlayerVolumeIndicator />
      </RootPrimitive>
    </MediaPlayerContext.Provider>
  );
}

interface MediaPlayerVideoProps extends React.ComponentProps<"video"> {
  asChild?: boolean;
}

function MediaPlayerVideo(props: MediaPlayerVideoProps) {
  const { asChild, ref, ...videoProps } = props;

  const context = useMediaPlayerContext("MediaPlayerVideo");
  const dispatch = useMediaDispatch();
  const mediaRefCallback = useMediaRef();
  const composedRef = useComposedRefs(ref, context.mediaRef, mediaRefCallback);

  const onPlayToggle = React.useCallback(
    (event: React.MouseEvent<HTMLVideoElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      const mediaElement = event.currentTarget;
      if (!mediaElement) return;

      dispatch({
        type: mediaElement.paused
          ? MediaActionTypes.MEDIA_PLAY_REQUEST
          : MediaActionTypes.MEDIA_PAUSE_REQUEST,
      });
    },
    [dispatch, props.onClick]
  );

  const VideoPrimitive = asChild ? Slot : "video";

  return (
    <VideoPrimitive
      aria-describedby={context.descriptionId}
      aria-labelledby={context.labelId}
      data-slot="media-player-video"
      {...videoProps}
      id={context.mediaId}
      onClick={onPlayToggle}
      ref={composedRef}
    />
  );
}

interface MediaPlayerAudioProps extends React.ComponentProps<"audio"> {
  asChild?: boolean;
}

function MediaPlayerAudio(props: MediaPlayerAudioProps) {
  const { asChild, ref, ...audioProps } = props;

  const context = useMediaPlayerContext("MediaPlayerAudio");
  const mediaRefCallback = useMediaRef();
  const composedRef = useComposedRefs(ref, context.mediaRef, mediaRefCallback);

  const AudioPrimitive = asChild ? Slot : "audio";

  return (
    <AudioPrimitive
      aria-describedby={context.descriptionId}
      aria-labelledby={context.labelId}
      data-slot="media-player-audio"
      {...audioProps}
      id={context.mediaId}
      ref={composedRef}
    />
  );
}

interface MediaPlayerControlsProps extends React.ComponentProps<"div"> {
  asChild?: boolean;
}

function MediaPlayerControls(props: MediaPlayerControlsProps) {
  const { asChild, className, ...controlsProps } = props;

  const context = useMediaPlayerContext("MediaPlayerControls");
  const isFullscreen = useMediaSelector(
    (state) => state.mediaIsFullscreen ?? false
  );
  const controlsVisible = useStoreSelector((state) => state.controlsVisible);

  const ControlsPrimitive = asChild ? Slot : "div";

  return (
    <ControlsPrimitive
      className={cn(
        "dark pointer-events-none absolute right-0 bottom-0 left-0 z-50 flex items-center gap-2 px-4 py-3 opacity-0 transition-opacity duration-200 data-[visible]:pointer-events-auto data-[visible]:opacity-100 [:fullscreen_&]:px-6 [:fullscreen_&]:py-4",
        className
      )}
      data-disabled={context.disabled ? "" : undefined}
      data-slot="media-player-controls"
      data-state={isFullscreen ? "fullscreen" : "windowed"}
      data-visible={controlsVisible ? "" : undefined}
      dir={context.dir}
      {...controlsProps}
    />
  );
}

interface MediaPlayerLoadingProps extends React.ComponentProps<"div"> {
  delayMs?: number;
  asChild?: boolean;
}

function MediaPlayerLoading(props: MediaPlayerLoadingProps) {
  const {
    delayMs = 500,
    asChild,
    className,
    children,
    ...loadingProps
  } = props;

  const isLoading = useMediaSelector((state) => state.mediaLoading ?? false);
  const isPaused = useMediaSelector((state) => state.mediaPaused ?? true);
  const hasPlayed = useMediaSelector((state) => state.mediaHasPlayed ?? false);

  const shouldShowLoading = isLoading && !isPaused;
  const shouldUseDelay = hasPlayed && shouldShowLoading;
  const loadingDelayMs = shouldUseDelay ? delayMs : 0;

  const [shouldRender, setShouldRender] = React.useState(false);
  const timeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  React.useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (shouldShowLoading) {
      if (loadingDelayMs > 0) {
        timeoutRef.current = setTimeout(() => {
          setShouldRender(true);
          timeoutRef.current = null;
        }, loadingDelayMs);
      } else {
        setShouldRender(true);
      }
    } else {
      setShouldRender(false);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [shouldShowLoading, loadingDelayMs]);

  if (!shouldRender) return null;

  const LoadingPrimitive = asChild ? Slot : "div";

  return (
    <LoadingPrimitive
      aria-live="polite"
      data-slot="media-player-loading"
      role="status"
      {...loadingProps}
      className={cn(
        "fade-in-0 zoom-in-95 pointer-events-none absolute inset-0 z-50 flex animate-in items-center justify-center duration-200",
        className
      )}
    >
      <Loader2Icon className="size-20 animate-spin stroke-[.0938rem] text-primary" />
    </LoadingPrimitive>
  );
}

interface MediaPlayerErrorProps extends React.ComponentProps<"div"> {
  error?: MediaError | null;
  label?: string;
  description?: string;
  onRetry?: () => void;
  onReload?: () => void;
  asChild?: boolean;
}

function MediaPlayerError(props: MediaPlayerErrorProps) {
  const {
    error: errorProp,
    label,
    description,
    onRetry: onRetryProp,
    onReload: onReloadProp,
    asChild,
    className,
    children,
    ...errorProps
  } = props;

  const context = useMediaPlayerContext("MediaPlayerError");
  const isFullscreen = useMediaSelector(
    (state) => state.mediaIsFullscreen ?? false
  );
  const mediaError = useMediaSelector((state) => state.mediaError);

  const error = errorProp ?? mediaError;

  const labelId = React.useId();
  const descriptionId = React.useId();

  const [actionState, setActionState] = React.useState<{
    retryPending: boolean;
    reloadPending: boolean;
  }>({
    retryPending: false,
    reloadPending: false,
  });

  const onRetry = React.useCallback(() => {
    setActionState((prev) => ({ ...prev, retryPending: true }));

    requestAnimationFrame(() => {
      const mediaElement = context.mediaRef.current;
      if (!mediaElement) {
        setActionState((prev) => ({ ...prev, retryPending: false }));
        return;
      }

      if (onRetryProp) {
        onRetryProp();
      } else {
        const currentSrc = mediaElement.currentSrc ?? mediaElement.src;
        if (currentSrc) {
          mediaElement.load();
        }
      }

      setActionState((prev) => ({ ...prev, retryPending: false }));
    });
  }, [context.mediaRef, onRetryProp]);

  const onReload = React.useCallback(() => {
    setActionState((prev) => ({ ...prev, reloadPending: true }));

    requestAnimationFrame(() => {
      if (onReloadProp) {
        onReloadProp();
      } else {
        window.location.reload();
      }
    });
  }, [onReloadProp]);

  const errorLabel = React.useMemo(() => {
    if (label) return label;

    if (!error) return "Playback Error";

    const labelMap: Record<number, string> = {
      [MediaError.MEDIA_ERR_ABORTED]: "Playback Interrupted",
      [MediaError.MEDIA_ERR_NETWORK]: "Connection Problem",
      [MediaError.MEDIA_ERR_DECODE]: "Media Error",
      [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "Unsupported Format",
    };

    return labelMap[error.code] ?? "Playback Error";
  }, [label, error]);

  const errorDescription = React.useMemo(() => {
    if (description) return description;

    if (!error) return "An unknown error occurred";

    const descriptionMap: Record<number, string> = {
      [MediaError.MEDIA_ERR_ABORTED]: "Media playback was aborted",
      [MediaError.MEDIA_ERR_NETWORK]:
        "A network error occurred while loading the media",
      [MediaError.MEDIA_ERR_DECODE]:
        "An error occurred while decoding the media",
      [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]:
        "The media format is not supported",
    };

    return descriptionMap[error.code] ?? "An unknown error occurred";
  }, [description, error]);

  if (!error) return null;

  const ErrorPrimitive = asChild ? Slot : "div";

  return (
    <ErrorPrimitive
      aria-describedby={descriptionId}
      aria-labelledby={labelId}
      aria-live="assertive"
      data-slot="media-player-error"
      data-state={isFullscreen ? "fullscreen" : "windowed"}
      role="alert"
      {...errorProps}
      className={cn(
        "pointer-events-auto absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 text-white backdrop-blur-sm",
        className
      )}
    >
      {children ?? (
        <div className="flex max-w-md flex-col items-center gap-4 px-6 py-8 text-center">
          <AlertTriangleIcon className="size-12 text-destructive" />
          <div className="flex flex-col gap-px text-center">
            <h3 className="font-semibold text-xl tracking-tight">
              {errorLabel}
            </h3>
            <p className="text-balance text-muted-foreground text-sm leading-relaxed">
              {errorDescription}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              disabled={actionState.retryPending}
              onClick={onRetry}
              size="sm"
              variant="secondary"
            >
              {actionState.retryPending ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RefreshCcwIcon />
              )}
              Try again
            </Button>
            <Button
              disabled={actionState.reloadPending}
              onClick={onReload}
              size="sm"
              variant="outline"
            >
              {actionState.reloadPending ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <RotateCcwIcon />
              )}
              Reload page
            </Button>
          </div>
        </div>
      )}
    </ErrorPrimitive>
  );
}

interface MediaPlayerVolumeIndicatorProps extends React.ComponentProps<"div"> {
  asChild?: boolean;
}

function MediaPlayerVolumeIndicator(props: MediaPlayerVolumeIndicatorProps) {
  const { asChild, className, ...indicatorProps } = props;

  const mediaVolume = useMediaSelector((state) => state.mediaVolume ?? 1);
  const mediaMuted = useMediaSelector((state) => state.mediaMuted ?? false);
  const mediaVolumeLevel = useMediaSelector(
    (state) => state.mediaVolumeLevel ?? "high"
  );
  const volumeIndicatorVisible = useStoreSelector(
    (state) => state.volumeIndicatorVisible
  );

  if (!volumeIndicatorVisible) return null;

  const effectiveVolume = mediaMuted ? 0 : mediaVolume;
  const volumePercentage = Math.round(effectiveVolume * 100);
  const barCount = 10;
  const activeBarCount = Math.ceil(effectiveVolume * barCount);

  const VolumeIndicatorPrimitive = asChild ? Slot : "div";

  return (
    <VolumeIndicatorPrimitive
      aria-label={`Volume ${mediaMuted ? "muted" : `${volumePercentage}%`}`}
      aria-live="polite"
      data-slot="media-player-volume-indicator"
      role="status"
      {...indicatorProps}
      className={cn(
        "pointer-events-none absolute inset-0 z-50 flex items-center justify-center",
        className
      )}
    >
      <div className="fade-in-0 zoom-in-95 flex animate-in flex-col items-center gap-3 rounded-lg bg-black/30 px-6 py-4 text-white backdrop-blur-xs duration-200">
        <div className="flex items-center gap-2">
          {mediaVolumeLevel === "off" || mediaMuted ? (
            <VolumeXIcon className="size-6" />
          ) : mediaVolumeLevel === "high" ? (
            <Volume2Icon className="size-6" />
          ) : (
            <Volume1Icon className="size-6" />
          )}
          <span className="font-medium text-sm tabular-nums">
            {mediaMuted ? "Muted" : `${volumePercentage}%`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {Array.from({ length: barCount }, (_, index) => (
            <div
              className={cn(
                "w-1.5 rounded-full transition-all duration-150",
                index < activeBarCount && !mediaMuted
                  ? "scale-100 bg-white"
                  : "scale-90 bg-white/30"
              )}
              key={index}
              style={{
                height: `${12 + index * 2}px`,
                animationDelay: `${index * 50}ms`,
              }}
            />
          ))}
        </div>
      </div>
    </VolumeIndicatorPrimitive>
  );
}

interface MediaPlayerControlsOverlayProps extends React.ComponentProps<"div"> {
  asChild?: boolean;
}

function MediaPlayerControlsOverlay(props: MediaPlayerControlsOverlayProps) {
  const { asChild, className, ...overlayProps } = props;

  const isFullscreen = useMediaSelector(
    (state) => state.mediaIsFullscreen ?? false
  );
  const controlsVisible = useStoreSelector((state) => state.controlsVisible);

  const OverlayPrimitive = asChild ? Slot : "div";

  return (
    <OverlayPrimitive
      data-slot="media-player-controls-overlay"
      data-state={isFullscreen ? "fullscreen" : "windowed"}
      data-visible={controlsVisible ? "" : undefined}
      {...overlayProps}
      className={cn(
        "-z-10 pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity duration-200 data-[visible]:opacity-100",
        className
      )}
    />
  );
}

type MediaPlayerPlayProps = React.ComponentProps<typeof Button>;

function MediaPlayerPlay(props: MediaPlayerPlayProps) {
  const { asChild, children, className, disabled, ...playButtonProps } = props;

  const context = useMediaPlayerContext("MediaPlayerPlay");
  const dispatch = useMediaDispatch();
  const mediaPaused = useMediaSelector((state) => state.mediaPaused ?? true);

  const isDisabled = disabled || context.disabled;

  const onPlayToggle = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: mediaPaused
          ? MediaActionTypes.MEDIA_PLAY_REQUEST
          : MediaActionTypes.MEDIA_PAUSE_REQUEST,
      });
    },
    [dispatch, props.onClick, mediaPaused]
  );

  return (
    <MediaPlayerTooltip
      shortcut="Space"
      tooltip={mediaPaused ? "Play" : "Pause"}
    >
      <Button
        aria-controls={context.mediaId}
        aria-label={mediaPaused ? "Play" : "Pause"}
        aria-pressed={!mediaPaused}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-play-button"
        data-state={mediaPaused ? "off" : "on"}
        disabled={isDisabled}
        type="button"
        {...playButtonProps}
        className={cn(
          "size-8 [&_svg:not([class*='fill-'])]:fill-current",
          className
        )}
        onClick={onPlayToggle}
        size="icon"
        variant="ghost"
      >
        {children ?? (mediaPaused ? <PlayIcon /> : <PauseIcon />)}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerSeekBackwardProps = React.ComponentProps<typeof Button> & {
  seconds?: number;
};

function MediaPlayerSeekBackward(props: MediaPlayerSeekBackwardProps) {
  const {
    seconds = SEEK_STEP_SHORT,
    asChild,
    children,
    className,
    disabled,
    ...seekBackwardProps
  } = props;

  const context = useMediaPlayerContext("MediaPlayerSeekBackward");
  const dispatch = useMediaDispatch();
  const mediaCurrentTime = useMediaSelector(
    (state) => state.mediaCurrentTime ?? 0
  );

  const isDisabled = disabled || context.disabled;

  const onSeekBackward = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: MediaActionTypes.MEDIA_SEEK_REQUEST,
        detail: Math.max(0, mediaCurrentTime - seconds),
      });
    },
    [dispatch, props.onClick, mediaCurrentTime, seconds]
  );

  return (
    <MediaPlayerTooltip
      shortcut={context.isVideo ? ["←"] : ["Shift ←"]}
      tooltip={`Back ${seconds}s`}
    >
      <Button
        aria-controls={context.mediaId}
        aria-label={`Back ${seconds} seconds`}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-seek-backward"
        disabled={isDisabled}
        type="button"
        {...seekBackwardProps}
        className={cn("size-8", className)}
        onClick={onSeekBackward}
        size="icon"
        variant="ghost"
      >
        {children ?? <RewindIcon />}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerSeekForwardProps = React.ComponentProps<typeof Button> & {
  // Add your additional props here
  seconds?: number;
};

function MediaPlayerSeekForward(props: MediaPlayerSeekForwardProps) {
  const {
    seconds = SEEK_STEP_LONG,
    asChild,
    children,
    className,
    disabled,
    ...seekForwardProps
  } = props;

  const context = useMediaPlayerContext("MediaPlayerSeekForward");
  const dispatch = useMediaDispatch();
  const mediaCurrentTime = useMediaSelector(
    (state) => state.mediaCurrentTime ?? 0
  );
  const [, seekableEnd] = useMediaSelector(
    (state) => state.mediaSeekable ?? [0, 0]
  );
  const isDisabled = disabled || context.disabled;

  const onSeekForward = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: MediaActionTypes.MEDIA_SEEK_REQUEST,
        detail: Math.min(
          seekableEnd ?? Number.POSITIVE_INFINITY,
          mediaCurrentTime + seconds
        ),
      });
    },
    [dispatch, props.onClick, mediaCurrentTime, seekableEnd, seconds]
  );

  return (
    <MediaPlayerTooltip
      shortcut={context.isVideo ? ["→"] : ["Shift →"]}
      tooltip={`Forward ${seconds}s`}
    >
      <Button
        aria-controls={context.mediaId}
        aria-label={`Forward ${seconds} seconds`}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-seek-forward"
        disabled={isDisabled}
        type="button"
        {...seekForwardProps}
        className={cn("size-8", className)}
        onClick={onSeekForward}
        size="icon"
        variant="ghost"
      >
        {children ?? <FastForwardIcon />}
      </Button>
    </MediaPlayerTooltip>
  );
}

interface SeekState {
  isHovering: boolean;
  pendingSeekTime: number | null;
  hasInitialPosition: boolean;
}

interface MediaPlayerSeekProps
  extends React.ComponentProps<typeof SliderPrimitive.Root> {
  withTime?: boolean;
  withoutChapter?: boolean;
  withoutTooltip?: boolean;
  tooltipThumbnailSrc?: string | ((time: number) => string);
  tooltipTimeVariant?: "current" | "progress";
  tooltipSideOffset?: number;
  tooltipCollisionBoundary?: Element | Element[];
  tooltipCollisionPadding?:
    | number
    | Partial<Record<"top" | "right" | "bottom" | "left", number>>;
}

function MediaPlayerSeek(props: MediaPlayerSeekProps) {
  const {
    withTime = false,
    withoutChapter = false,
    withoutTooltip = false,
    tooltipTimeVariant = "current",
    tooltipThumbnailSrc,
    tooltipSideOffset,
    tooltipCollisionPadding = SEEK_COLLISION_PADDING,
    tooltipCollisionBoundary,
    className,
    disabled,
    ...seekProps
  } = props;

  const context = useMediaPlayerContext(SEEK_NAME);
  const store = useStoreContext(SEEK_NAME);
  const dispatch = useMediaDispatch();
  const mediaCurrentTime = useMediaSelector(
    (state) => state.mediaCurrentTime ?? 0
  );
  const [seekableStart = 0, seekableEnd = 0] = useMediaSelector(
    (state) => state.mediaSeekable ?? [0, 0]
  );
  const mediaBuffered = useMediaSelector((state) => state.mediaBuffered ?? []);
  const mediaEnded = useMediaSelector((state) => state.mediaEnded ?? false);

  const chapterCues = useMediaSelector(
    (state) => state.mediaChaptersCues ?? []
  );
  const mediaPreviewTime = useMediaSelector((state) => state.mediaPreviewTime);
  const mediaPreviewImage = useMediaSelector(
    (state) => state.mediaPreviewImage
  );
  const mediaPreviewCoords = useMediaSelector(
    (state) => state.mediaPreviewCoords
  );

  const seekRef = React.useRef<HTMLDivElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);
  const justCommittedRef = React.useRef<boolean>(false);

  const hoverTimeRef = React.useRef(0);
  const tooltipXRef = React.useRef(0);
  const tooltipYRef = React.useRef(0);
  const seekRectRef = React.useRef<DOMRect | null>(null);
  const collisionDataRef = React.useRef<{
    padding: { top: number; right: number; bottom: number; left: number };
    boundaries: Element[];
  } | null>(null);

  const [seekState, setSeekState] = React.useState<SeekState>({
    isHovering: false,
    pendingSeekTime: null,
    hasInitialPosition: false,
  });

  const rafIdRef = React.useRef<number | null>(null);
  const seekThrottleRef = React.useRef<number | null>(null);
  const hoverTimeoutRef = React.useRef<number | null>(null);
  const lastPointerXRef = React.useRef<number>(0);
  const lastPointerYRef = React.useRef<number>(0);
  const previewDebounceRef = React.useRef<number | null>(null);
  const pointerEnterTimeRef = React.useRef<number>(0);
  const horizontalMovementRef = React.useRef<number>(0);
  const verticalMovementRef = React.useRef<number>(0);
  const lastSeekCommitTimeRef = React.useRef<number>(0);

  const timeCache = React.useRef<Map<number, string>>(new Map());

  const displayValue = seekState.pendingSeekTime ?? mediaCurrentTime;

  const isDisabled = disabled || context.disabled;
  const tooltipDisabled =
    withoutTooltip || context.withoutTooltip || store.getState().menuOpen;

  const currentTooltipSideOffset =
    tooltipSideOffset ?? context.tooltipSideOffset;

  const getCachedTime = React.useCallback((time: number, duration: number) => {
    const roundedTime = Math.floor(time);
    const key = roundedTime + duration * 10_000;

    if (timeCache.current.has(key)) {
      return timeCache.current.get(key) as string;
    }

    const formatted = timeUtils.formatTime(time, duration);
    timeCache.current.set(key, formatted);

    if (timeCache.current.size > 100) {
      timeCache.current.clear();
    }

    return formatted;
  }, []);

  const currentTime = getCachedTime(displayValue, seekableEnd);
  const duration = getCachedTime(seekableEnd, seekableEnd);
  const remainingTime = getCachedTime(seekableEnd - displayValue, seekableEnd);

  const onCollisionDataUpdate = React.useCallback(() => {
    if (collisionDataRef.current) return collisionDataRef.current;

    const padding =
      typeof tooltipCollisionPadding === "number"
        ? {
            top: tooltipCollisionPadding,
            right: tooltipCollisionPadding,
            bottom: tooltipCollisionPadding,
            left: tooltipCollisionPadding,
          }
        : { top: 0, right: 0, bottom: 0, left: 0, ...tooltipCollisionPadding };

    const boundaries = tooltipCollisionBoundary
      ? Array.isArray(tooltipCollisionBoundary)
        ? tooltipCollisionBoundary
        : [tooltipCollisionBoundary]
      : ([context.rootRef.current].filter(Boolean) as Element[]);

    collisionDataRef.current = { padding, boundaries };
    return collisionDataRef.current;
  }, [tooltipCollisionPadding, tooltipCollisionBoundary, context.rootRef]);

  const getCurrentChapterCue = React.useCallback(
    (time: number) => {
      if (withoutChapter || chapterCues.length === 0) return null;
      return chapterCues.find((c) => time >= c.startTime && time < c.endTime);
    },
    [chapterCues, withoutChapter]
  );

  const getThumbnail = React.useCallback(
    (time: number) => {
      if (tooltipDisabled) return null;

      if (tooltipThumbnailSrc) {
        const src =
          typeof tooltipThumbnailSrc === "function"
            ? tooltipThumbnailSrc(time)
            : tooltipThumbnailSrc;
        return { src, coords: null };
      }

      if (
        mediaPreviewTime !== undefined &&
        Math.abs(time - mediaPreviewTime) < 0.1 &&
        mediaPreviewImage
      ) {
        return {
          src: mediaPreviewImage,
          coords: mediaPreviewCoords ?? null,
        };
      }

      return null;
    },
    [
      tooltipThumbnailSrc,
      mediaPreviewTime,
      mediaPreviewImage,
      mediaPreviewCoords,
      tooltipDisabled,
    ]
  );

  const onPreviewUpdate = React.useCallback(
    (time: number) => {
      if (tooltipDisabled) return;

      if (previewDebounceRef.current) {
        cancelAnimationFrame(previewDebounceRef.current);
      }

      previewDebounceRef.current = requestAnimationFrame(() => {
        dispatch({
          type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
          detail: time,
        });
        previewDebounceRef.current = null;
      });
    },
    [dispatch, tooltipDisabled]
  );

  const onTooltipPositionUpdate = React.useCallback(
    (clientX: number) => {
      if (!seekRef.current) return;

      const tooltipWidth =
        tooltipRef.current?.offsetWidth ?? SEEK_TOOLTIP_WIDTH_FALLBACK;

      let x = clientX;
      const y = seekRectRef.current?.top ?? 0;

      const collisionData = onCollisionDataUpdate();
      const halfTooltipWidth = tooltipWidth / 2;

      let minLeft = 0;
      let maxRight = window.innerWidth;

      for (const boundary of collisionData.boundaries) {
        const boundaryRect = boundary.getBoundingClientRect();
        minLeft = Math.max(
          minLeft,
          boundaryRect.left + collisionData.padding.left
        );
        maxRight = Math.min(
          maxRight,
          boundaryRect.right - collisionData.padding.right
        );
      }

      if (x - halfTooltipWidth < minLeft) {
        x = minLeft + halfTooltipWidth;
      } else if (x + halfTooltipWidth > maxRight) {
        x = maxRight - halfTooltipWidth;
      }

      const viewportPadding = SEEK_COLLISION_PADDING;
      if (x - halfTooltipWidth < viewportPadding) {
        x = viewportPadding + halfTooltipWidth;
      } else if (x + halfTooltipWidth > window.innerWidth - viewportPadding) {
        x = window.innerWidth - viewportPadding - halfTooltipWidth;
      }

      tooltipXRef.current = x;
      tooltipYRef.current = y;

      if (tooltipRef.current) {
        tooltipRef.current.style.setProperty(SEEK_TOOLTIP_X, `${x}px`);
        tooltipRef.current.style.setProperty(SEEK_TOOLTIP_Y, `${y}px`);
      }

      if (!seekState.hasInitialPosition) {
        setSeekState((prev) => ({ ...prev, hasInitialPosition: true }));
      }
    },
    [onCollisionDataUpdate, seekState.hasInitialPosition]
  );

  const onHoverProgressUpdate = React.useCallback(() => {
    if (!seekRef.current || seekableEnd <= 0) return;

    const hoverPercent = Math.min(
      100,
      (hoverTimeRef.current / seekableEnd) * 100
    );
    seekRef.current.style.setProperty(
      SEEK_HOVER_PERCENT,
      `${hoverPercent.toFixed(4)}%`
    );
  }, [seekableEnd]);

  React.useEffect(() => {
    if (seekState.pendingSeekTime !== null) {
      const diff = Math.abs(mediaCurrentTime - seekState.pendingSeekTime);
      if (diff < 0.5) {
        setSeekState((prev) => ({ ...prev, pendingSeekTime: null }));
      }
    }
  }, [mediaCurrentTime, seekState.pendingSeekTime]);

  React.useEffect(() => {
    if (!seekState.isHovering || tooltipDisabled) return;

    function onScroll() {
      setSeekState((prev) => ({
        ...prev,
        isHovering: false,
        hasInitialPosition: false,
      }));
      dispatch({
        type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
        detail: undefined,
      });
    }

    document.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll);
    };
  }, [dispatch, seekState.isHovering, tooltipDisabled]);

  const bufferedProgress = React.useMemo(() => {
    if (mediaBuffered.length === 0 || seekableEnd <= 0) return 0;

    if (mediaEnded) return 1;

    const containingRange = mediaBuffered.find(
      ([start, end]) => start <= mediaCurrentTime && mediaCurrentTime <= end
    );

    if (containingRange) {
      return Math.min(1, containingRange[1] / seekableEnd);
    }

    return Math.min(1, seekableStart / seekableEnd);
  }, [mediaBuffered, mediaCurrentTime, seekableEnd, mediaEnded, seekableStart]);

  const onPointerEnter = React.useCallback(() => {
    if (seekRef.current) {
      seekRectRef.current = seekRef.current.getBoundingClientRect();
    }

    collisionDataRef.current = null;
    pointerEnterTimeRef.current = Date.now();
    horizontalMovementRef.current = 0;
    verticalMovementRef.current = 0;

    if (seekableEnd > 0) {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }

      if (!tooltipDisabled && lastPointerXRef.current && seekRectRef.current) {
        const clientX = Math.max(
          seekRectRef.current.left,
          Math.min(lastPointerXRef.current, seekRectRef.current.right)
        );
        onTooltipPositionUpdate(clientX);
      }
    }
  }, [seekableEnd, onTooltipPositionUpdate, tooltipDisabled]);

  const onPointerLeave = React.useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (previewDebounceRef.current) {
      cancelAnimationFrame(previewDebounceRef.current);
      previewDebounceRef.current = null;
    }

    setSeekState((prev) => ({
      ...prev,
      isHovering: false,
      hasInitialPosition: false,
    }));

    justCommittedRef.current = false;
    seekRectRef.current = null;
    collisionDataRef.current = null;

    pointerEnterTimeRef.current = 0;
    horizontalMovementRef.current = 0;
    verticalMovementRef.current = 0;
    lastPointerXRef.current = 0;
    lastPointerYRef.current = 0;
    lastSeekCommitTimeRef.current = 0;

    if (!tooltipDisabled) {
      dispatch({
        type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
        detail: undefined,
      });
    }
  }, [dispatch, tooltipDisabled]);

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (seekableEnd <= 0) return;

      if (!seekRectRef.current && seekRef.current) {
        seekRectRef.current = seekRef.current.getBoundingClientRect();
      }

      if (!seekRectRef.current) return;

      const currentX = event.clientX;
      const currentY = event.clientY;

      if (lastPointerXRef.current !== 0 && lastPointerYRef.current !== 0) {
        const deltaX = Math.abs(currentX - lastPointerXRef.current);
        const deltaY = Math.abs(currentY - lastPointerYRef.current);

        horizontalMovementRef.current += deltaX;
        verticalMovementRef.current += deltaY;
      }

      lastPointerXRef.current = currentX;
      lastPointerYRef.current = currentY;

      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }

      rafIdRef.current = requestAnimationFrame(() => {
        const wasJustCommitted = justCommittedRef.current;
        if (wasJustCommitted) {
          justCommittedRef.current = false;
        }

        const seekRect = seekRectRef.current;
        if (!seekRect) {
          rafIdRef.current = null;
          return;
        }

        const clientX = lastPointerXRef.current;
        const offsetXOnSeekBar = Math.max(
          0,
          Math.min(clientX - seekRect.left, seekRect.width)
        );
        const relativeX = offsetXOnSeekBar / seekRect.width;
        const calculatedHoverTime = relativeX * seekableEnd;

        hoverTimeRef.current = calculatedHoverTime;

        onHoverProgressUpdate();

        const wasHovering = seekState.isHovering;
        const isCurrentlyHovering =
          clientX >= seekRect.left && clientX <= seekRect.right;

        const timeHovering = Date.now() - pointerEnterTimeRef.current;
        const totalMovement =
          horizontalMovementRef.current + verticalMovementRef.current;
        const horizontalRatio =
          totalMovement > 0 ? horizontalMovementRef.current / totalMovement : 0;

        const timeSinceSeekCommit = Date.now() - lastSeekCommitTimeRef.current;
        const isInSeekCooldown = timeSinceSeekCommit < 300;

        const shouldShowTooltip =
          !(wasJustCommitted || isInSeekCooldown) &&
          (timeHovering > 150 ||
            horizontalRatio > 0.6 ||
            (totalMovement < 10 && timeHovering > 50));

        if (
          !wasHovering &&
          isCurrentlyHovering &&
          shouldShowTooltip &&
          !tooltipDisabled
        ) {
          setSeekState((prev) => ({ ...prev, isHovering: true }));
        }

        if (!tooltipDisabled) {
          onPreviewUpdate(calculatedHoverTime);

          if (isCurrentlyHovering && (wasHovering || shouldShowTooltip)) {
            onTooltipPositionUpdate(clientX);
          }
        }

        rafIdRef.current = null;
      });
    },
    [
      onPreviewUpdate,
      onTooltipPositionUpdate,
      onHoverProgressUpdate,
      seekableEnd,
      seekState.isHovering,
      tooltipDisabled,
    ]
  );

  const onSeek = React.useCallback(
    (value: number[]) => {
      const time = value[0] ?? 0;

      setSeekState((prev) => ({ ...prev, pendingSeekTime: time }));

      if (!store.getState().dragging) {
        store.setState("dragging", true);
      }

      if (seekThrottleRef.current) {
        cancelAnimationFrame(seekThrottleRef.current);
      }

      seekThrottleRef.current = requestAnimationFrame(() => {
        dispatch({
          type: MediaActionTypes.MEDIA_SEEK_REQUEST,
          detail: time,
        });
        seekThrottleRef.current = null;
      });
    },
    [dispatch, store.getState, store.setState]
  );

  const onSeekCommit = React.useCallback(
    (value: number[]) => {
      const time = value[0] ?? 0;

      if (seekThrottleRef.current) {
        cancelAnimationFrame(seekThrottleRef.current);
        seekThrottleRef.current = null;
      }

      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (previewDebounceRef.current) {
        cancelAnimationFrame(previewDebounceRef.current);
        previewDebounceRef.current = null;
      }

      setSeekState((prev) => ({
        ...prev,
        pendingSeekTime: time,
        isHovering: false,
        hasInitialPosition: false,
      }));

      justCommittedRef.current = true;
      collisionDataRef.current = null;
      lastSeekCommitTimeRef.current = Date.now();

      // Reset movement tracking after seek commit
      pointerEnterTimeRef.current = Date.now();
      horizontalMovementRef.current = 0;
      verticalMovementRef.current = 0;

      if (store.getState().dragging) {
        store.setState("dragging", false);
      }

      dispatch({
        type: MediaActionTypes.MEDIA_SEEK_REQUEST,
        detail: time,
      });

      dispatch({
        type: MediaActionTypes.MEDIA_PREVIEW_REQUEST,
        detail: undefined,
      });
    },
    [dispatch, store.getState, store.setState]
  );

  React.useEffect(() => {
    return () => {
      if (seekThrottleRef.current) {
        cancelAnimationFrame(seekThrottleRef.current);
      }
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (previewDebounceRef.current) {
        cancelAnimationFrame(previewDebounceRef.current);
      }
    };
  }, []);

  const currentChapterCue = getCurrentChapterCue(hoverTimeRef.current);
  const thumbnail = getThumbnail(hoverTimeRef.current);
  const hoverTime = getCachedTime(hoverTimeRef.current, seekableEnd);

  const chapterSeparators = React.useMemo(() => {
    if (withoutChapter || chapterCues.length <= 1 || seekableEnd <= 0) {
      return null;
    }

    return chapterCues.slice(1).map((chapterCue, index) => {
      const position = (chapterCue.startTime / seekableEnd) * 100;

      return (
        <div
          aria-hidden="true"
          className="absolute top-0 h-full bg-zinc-50 dark:bg-zinc-950"
          data-slot="media-player-seek-chapter-separator"
          key={`chapter-${index}-${chapterCue.startTime}`}
          role="presentation"
          style={{
            width: ".1563rem",
            left: `${position}%`,
            transform: "translateX(-50%)",
          }}
        />
      );
    });
  }, [chapterCues, seekableEnd, withoutChapter]);

  const spriteStyle = React.useMemo<React.CSSProperties>(() => {
    if (!(thumbnail?.coords && thumbnail?.src)) {
      return {};
    }

    const coordX = thumbnail.coords[0];
    const coordY = thumbnail.coords[1];

    const spriteWidth = Number.parseFloat(thumbnail.coords[2] ?? "0");
    const spriteHeight = Number.parseFloat(thumbnail.coords[3] ?? "0");

    const scaleX = spriteWidth > 0 ? SPRITE_CONTAINER_WIDTH / spriteWidth : 1;
    const scaleY =
      spriteHeight > 0 ? SPRITE_CONTAINER_HEIGHT / spriteHeight : 1;
    const scale = Math.min(scaleX, scaleY);

    return {
      width: `${spriteWidth}px`,
      height: `${spriteHeight}px`,
      backgroundImage: `url(${thumbnail.src})`,
      backgroundPosition: `-${coordX}px -${coordY}px`,
      backgroundRepeat: "no-repeat",
      transform: `scale(${scale})`,
      transformOrigin: "top left",
    };
  }, [thumbnail?.coords, thumbnail?.src]);

  const SeekSlider = (
    <div className="relative w-full" data-slot="media-player-seek-container">
      <SliderPrimitive.Root
        aria-controls={context.mediaId}
        aria-valuetext={`${currentTime} of ${duration}`}
        data-hovering={seekState.isHovering ? "" : undefined}
        data-slider=""
        data-slot="media-player-seek"
        disabled={isDisabled}
        {...seekProps}
        className={cn(
          "relative flex w-full touch-none select-none items-center data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className
        )}
        max={seekableEnd}
        min={seekableStart}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
        onValueChange={onSeek}
        onValueCommit={onSeekCommit}
        ref={seekRef}
        step={0.01}
        value={[displayValue]}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-primary/40">
          <div
            className="absolute h-full bg-primary/70 will-change-[width]"
            data-slot="media-player-seek-buffered"
            style={{
              width: `${bufferedProgress * 100}%`,
            }}
          />
          <SliderPrimitive.Range className="absolute h-full bg-primary will-change-[width]" />
          {seekState.isHovering && seekableEnd > 0 && (
            <div
              className="absolute h-full bg-primary/70 will-change-[width,opacity]"
              data-slot="media-player-seek-hover-range"
              style={{
                width: `var(${SEEK_HOVER_PERCENT}, 0%)`,
                transition: "opacity 150ms ease-out",
              }}
            />
          )}
          {chapterSeparators}
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="relative z-10 block size-2.5 shrink-0 rounded-full bg-primary shadow-sm ring-ring/50 transition-[color,box-shadow] will-change-transform hover:ring-4 focus-visible:outline-hidden focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50" />
      </SliderPrimitive.Root>
      {!(withoutTooltip || context.withoutTooltip) &&
        seekState.isHovering &&
        seekableEnd > 0 && (
          <MediaPlayerPortal>
            <div
              className="pointer-events-none z-50 [backface-visibility:hidden] [contain:layout_style] [transition:opacity_150ms_ease-in-out]"
              ref={tooltipRef}
              style={{
                position: "fixed" as const,
                left: `var(${SEEK_TOOLTIP_X}, 0rem)`,
                top: `var(${SEEK_TOOLTIP_Y}, 0rem)`,
                transform: `translateX(-50%) translateY(calc(-100% - ${currentTooltipSideOffset}px))`,
                visibility: seekState.hasInitialPosition ? "visible" : "hidden",
                opacity: seekState.hasInitialPosition ? 1 : 0,
              }}
            >
              <div
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-md border bg-background text-foreground shadow-sm dark:bg-zinc-900",
                  thumbnail && "min-h-10",
                  !thumbnail && currentChapterCue && "px-3 py-1.5"
                )}
              >
                {thumbnail?.src && (
                  <div
                    className="overflow-hidden rounded-md rounded-b-none"
                    data-slot="media-player-seek-thumbnail"
                    style={{
                      width: `${SPRITE_CONTAINER_WIDTH}px`,
                      height: `${SPRITE_CONTAINER_HEIGHT}px`,
                    }}
                  >
                    {thumbnail.coords ? (
                      <div style={spriteStyle} />
                    ) : (
                      <img
                        alt={`Preview at ${hoverTime}`}
                        className="size-full object-cover"
                        src={thumbnail.src}
                      />
                    )}
                  </div>
                )}
                {currentChapterCue && (
                  <div
                    className="line-clamp-2 max-w-48 text-balance text-center text-xs"
                    data-slot="media-player-seek-chapter-title"
                  >
                    {currentChapterCue.text}
                  </div>
                )}
                <div
                  className={cn(
                    "whitespace-nowrap text-center text-xs tabular-nums",
                    thumbnail && "pb-1.5",
                    !(thumbnail || currentChapterCue) && "px-2.5 py-1"
                  )}
                  data-slot="media-player-seek-time"
                >
                  {tooltipTimeVariant === "progress"
                    ? `${hoverTime} / ${duration}`
                    : hoverTime}
                </div>
              </div>
            </div>
          </MediaPlayerPortal>
        )}
    </div>
  );

  if (withTime) {
    return (
      <div className="flex w-full items-center gap-2">
        <span className="text-sm tabular-nums">{currentTime}</span>
        {SeekSlider}
        <span className="text-sm tabular-nums">{remainingTime}</span>
      </div>
    );
  }

  return SeekSlider;
}

interface MediaPlayerVolumeProps
  extends React.ComponentProps<typeof SliderPrimitive.Root> {
  asChild?: boolean;
  expandable?: boolean;
}

function MediaPlayerVolume(props: MediaPlayerVolumeProps) {
  const {
    asChild,
    expandable = false,
    className,
    disabled,
    ...volumeProps
  } = props;

  const context = useMediaPlayerContext(VOLUME_NAME);
  const store = useStoreContext(VOLUME_NAME);
  const dispatch = useMediaDispatch();
  const mediaVolume = useMediaSelector((state) => state.mediaVolume ?? 1);
  const mediaMuted = useMediaSelector((state) => state.mediaMuted ?? false);
  const mediaVolumeLevel = useMediaSelector(
    (state) => state.mediaVolumeLevel ?? "high"
  );

  const sliderId = React.useId();
  const volumeTriggerId = React.useId();

  const isDisabled = disabled || context.disabled;

  const onMute = React.useCallback(() => {
    dispatch({
      type: mediaMuted
        ? MediaActionTypes.MEDIA_UNMUTE_REQUEST
        : MediaActionTypes.MEDIA_MUTE_REQUEST,
    });
  }, [dispatch, mediaMuted]);

  const onVolumeChange = React.useCallback(
    (value: number[]) => {
      const volume = value[0] ?? 0;

      if (!store.getState().dragging) {
        store.setState("dragging", true);
      }

      dispatch({
        type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
        detail: volume,
      });
    },
    [dispatch, store.getState, store.setState]
  );

  const onVolumeCommit = React.useCallback(
    (value: number[]) => {
      const volume = value[0] ?? 0;

      if (store.getState().dragging) {
        store.setState("dragging", false);
      }

      dispatch({
        type: MediaActionTypes.MEDIA_VOLUME_REQUEST,
        detail: volume,
      });
    },
    [dispatch, store]
  );

  const effectiveVolume = mediaMuted ? 0 : mediaVolume;

  return (
    <div
      className={cn(
        "group flex items-center",
        expandable
          ? "gap-0 group-focus-within:gap-2 group-hover:gap-1.5"
          : "gap-1.5",
        className
      )}
      data-disabled={isDisabled ? "" : undefined}
      data-slot="media-player-volume-container"
    >
      <MediaPlayerTooltip shortcut="M" tooltip="Volume">
        <Button
          aria-controls={`${context.mediaId} ${sliderId}`}
          aria-label={mediaMuted ? "Unmute" : "Mute"}
          aria-pressed={mediaMuted}
          className="size-8"
          data-slot="media-player-volume-trigger"
          data-state={mediaMuted ? "on" : "off"}
          disabled={isDisabled}
          id={volumeTriggerId}
          onClick={onMute}
          size="icon"
          type="button"
          variant="ghost"
        >
          {mediaVolumeLevel === "off" || mediaMuted ? (
            <VolumeXIcon />
          ) : mediaVolumeLevel === "high" ? (
            <Volume2Icon />
          ) : (
            <Volume1Icon />
          )}
        </Button>
      </MediaPlayerTooltip>
      <SliderPrimitive.Root
        aria-controls={context.mediaId}
        aria-valuetext={`${Math.round(effectiveVolume * 100)}% volume`}
        data-slider=""
        data-slot="media-player-volume"
        id={sliderId}
        {...volumeProps}
        className={cn(
          "relative flex touch-none select-none items-center",
          expandable
            ? "w-0 opacity-0 transition-[width,opacity] duration-200 ease-in-out group-focus-within:w-16 group-focus-within:opacity-100 group-hover:w-16 group-hover:opacity-100"
            : "w-16",
          className
        )}
        disabled={isDisabled}
        max={1}
        min={0}
        onValueChange={onVolumeChange}
        onValueCommit={onVolumeCommit}
        step={0.1}
        value={[effectiveVolume]}
      >
        <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-zinc-500">
          <SliderPrimitive.Range className="absolute h-full bg-primary will-change-[width]" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className="block size-2.5 shrink-0 rounded-full bg-primary shadow-sm ring-ring/50 transition-[color,box-shadow] will-change-transform hover:ring-4 focus-visible:outline-hidden focus-visible:ring-4 disabled:pointer-events-none disabled:opacity-50" />
      </SliderPrimitive.Root>
    </div>
  );
}

interface MediaPlayerTimeProps extends React.ComponentProps<"div"> {
  variant?: "progress" | "remaining" | "duration";
  asChild?: boolean;
}

function MediaPlayerTime(props: MediaPlayerTimeProps) {
  const { variant = "progress", asChild, className, ...timeProps } = props;

  const context = useMediaPlayerContext("MediaPlayerTime");
  const mediaCurrentTime = useMediaSelector(
    (state) => state.mediaCurrentTime ?? 0
  );
  const [, seekableEnd = 0] = useMediaSelector(
    (state) => state.mediaSeekable ?? [0, 0]
  );

  const times = React.useMemo(() => {
    if (variant === "remaining") {
      return {
        remaining: timeUtils.formatTime(
          seekableEnd - mediaCurrentTime,
          seekableEnd
        ),
      };
    }

    if (variant === "duration") {
      return {
        duration: timeUtils.formatTime(seekableEnd, seekableEnd),
      };
    }

    return {
      current: timeUtils.formatTime(mediaCurrentTime, seekableEnd),
      duration: timeUtils.formatTime(seekableEnd, seekableEnd),
    };
  }, [variant, mediaCurrentTime, seekableEnd]);

  const TimePrimitive = asChild ? Slot : "div";

  if (variant === "remaining" || variant === "duration") {
    return (
      <TimePrimitive
        data-slot="media-player-time"
        data-variant={variant}
        dir={context.dir}
        {...timeProps}
        className={cn("text-foreground/80 text-sm tabular-nums", className)}
      >
        {times[variant]}
      </TimePrimitive>
    );
  }

  return (
    <TimePrimitive
      data-slot="media-player-time"
      data-variant={variant}
      dir={context.dir}
      {...timeProps}
      className={cn(
        "flex items-center gap-1 text-foreground/80 text-sm",
        className
      )}
    >
      <span className="tabular-nums">{times.current}</span>
      <span aria-hidden="true" role="separator" tabIndex={-1}>
        /
      </span>
      <span className="tabular-nums">{times.duration}</span>
    </TimePrimitive>
  );
}

type MediaPlayerPlaybackSpeedProps = React.ComponentProps<
  typeof DropdownMenuTrigger
> &
  React.ComponentProps<typeof Button> &
  Omit<React.ComponentProps<typeof DropdownMenu>, "dir"> &
  Pick<React.ComponentProps<typeof DropdownMenuContent>, "sideOffset"> & {
    speeds?: number[];
  };

function MediaPlayerPlaybackSpeed(props: MediaPlayerPlaybackSpeedProps) {
  const {
    open,
    defaultOpen,
    onOpenChange: onOpenChangeProp,
    sideOffset = FLOATING_MENU_SIDE_OFFSET,
    speeds = SPEEDS,
    asChild,
    modal = false,
    className,
    disabled,
    ...playbackSpeedProps
  } = props;

  const context = useMediaPlayerContext(PLAYBACK_SPEED_NAME);
  const store = useStoreContext(PLAYBACK_SPEED_NAME);
  const dispatch = useMediaDispatch();
  const mediaPlaybackRate = useMediaSelector(
    (state) => state.mediaPlaybackRate ?? 1
  );

  const isDisabled = disabled || context.disabled;

  const onPlaybackRateChange = React.useCallback(
    (rate: number) => {
      dispatch({
        type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
        detail: rate,
      });
    },
    [dispatch]
  );

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      store.setState("menuOpen", open);
      onOpenChangeProp?.(open);
    },
    [store.setState, onOpenChangeProp]
  );

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      modal={modal}
      onOpenChange={onOpenChange}
      open={open}
    >
      <MediaPlayerTooltip shortcut={["<", ">"]} tooltip="Playback speed">
        <DropdownMenuTrigger asChild>
          <Button
            aria-controls={context.mediaId}
            disabled={isDisabled}
            type="button"
            {...playbackSpeedProps}
            className={cn(
              "h-8 w-16 aria-[expanded=true]:bg-accent/50",
              className
            )}
            size="icon"
            variant="ghost"
          >
            {mediaPlaybackRate}x
          </Button>
        </DropdownMenuTrigger>
      </MediaPlayerTooltip>
      <DropdownMenuContent
        align="center"
        className="min-w-[var(--radix-dropdown-menu-trigger-width)] data-[side=top]:mb-3.5"
        sideOffset={sideOffset}
      >
        {speeds.map((speed) => (
          <DropdownMenuItem
            className="justify-between"
            key={speed}
            onSelect={() => onPlaybackRateChange(speed)}
          >
            {speed}x{mediaPlaybackRate === speed && <CheckIcon />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type MediaPlayerLoopProps = React.ComponentProps<typeof Button> & {};

function MediaPlayerLoop(props: MediaPlayerLoopProps) {
  const { children, className, disabled, ...loopProps } = props;

  const context = useMediaPlayerContext("MediaPlayerLoop");
  const isDisabled = disabled || context.disabled;

  const [isLooping, setIsLooping] = React.useState(() => {
    const mediaElement = context.mediaRef.current;
    return mediaElement?.loop ?? false;
  });

  React.useEffect(() => {
    const mediaElement = context.mediaRef.current;
    if (!mediaElement) return;

    setIsLooping(mediaElement.loop);

    const checkLoop = () => setIsLooping(mediaElement.loop);
    const observer = new MutationObserver(checkLoop);
    observer.observe(mediaElement, {
      attributes: true,
      attributeFilter: ["loop"],
    });

    return () => observer.disconnect();
  }, [context.mediaRef]);

  const onLoopToggle = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);
      if (event.defaultPrevented) return;

      const mediaElement = context.mediaRef.current;
      if (mediaElement) {
        const newLoopState = !mediaElement.loop;
        mediaElement.loop = newLoopState;
        setIsLooping(newLoopState);
      }
    },
    [context.mediaRef, props.onClick]
  );

  return (
    <MediaPlayerTooltip
      shortcut="R"
      tooltip={isLooping ? "Disable loop" : "Enable loop"}
    >
      <Button
        aria-controls={context.mediaId}
        aria-label={isLooping ? "Disable loop" : "Enable loop"}
        aria-pressed={isLooping}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-loop"
        data-state={isLooping ? "on" : "off"}
        disabled={isDisabled}
        type="button"
        {...loopProps}
        className={cn("size-8", className)}
        onClick={onLoopToggle}
        size="icon"
        variant="ghost"
      >
        {children ??
          (isLooping ? (
            <RepeatIcon className="text-muted-foreground" />
          ) : (
            <RepeatIcon />
          ))}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerFullscreenProps = React.ComponentProps<typeof Button> & {};

function MediaPlayerFullscreen(props: MediaPlayerFullscreenProps) {
  const { children, className, disabled, ...fullscreenProps } = props;

  const context = useMediaPlayerContext("MediaPlayerFullscreen");
  const dispatch = useMediaDispatch();
  const isFullscreen = useMediaSelector(
    (state) => state.mediaIsFullscreen ?? false
  );

  const isDisabled = disabled || context.disabled;

  const onFullscreen = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: isFullscreen
          ? MediaActionTypes.MEDIA_EXIT_FULLSCREEN_REQUEST
          : MediaActionTypes.MEDIA_ENTER_FULLSCREEN_REQUEST,
      });
    },
    [dispatch, props.onClick, isFullscreen]
  );

  return (
    <MediaPlayerTooltip shortcut="F" tooltip="Fullscreen">
      <Button
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-fullscreen"
        data-state={isFullscreen ? "on" : "off"}
        disabled={isDisabled}
        type="button"
        {...fullscreenProps}
        className={cn("size-8", className)}
        onClick={onFullscreen}
        size="icon"
        variant="ghost"
      >
        {children ?? (isFullscreen ? <Minimize2Icon /> : <Maximize2Icon />)}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerPiPProps = React.ComponentProps<typeof Button> & {
  onPipError?: (error: unknown, state: "enter" | "exit") => void;
};

function MediaPlayerPiP(props: MediaPlayerPiPProps) {
  const { children, className, onPipError, disabled, ...pipButtonProps } =
    props;

  const context = useMediaPlayerContext("MediaPlayerPiP");
  const dispatch = useMediaDispatch();
  const isPictureInPicture = useMediaSelector(
    (state) => state.mediaIsPip ?? false
  );

  const isDisabled = disabled || context.disabled;

  const onPictureInPicture = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: isPictureInPicture
          ? MediaActionTypes.MEDIA_EXIT_PIP_REQUEST
          : MediaActionTypes.MEDIA_ENTER_PIP_REQUEST,
      });

      const mediaElement = context.mediaRef.current;

      if (mediaElement instanceof HTMLVideoElement) {
        if (isPictureInPicture) {
          document.exitPictureInPicture().catch((error) => {
            onPipError?.(error, "exit");
          });
        } else {
          mediaElement.requestPictureInPicture().catch((error) => {
            onPipError?.(error, "enter");
          });
        }
      }
    },
    [dispatch, props.onClick, isPictureInPicture, onPipError, context.mediaRef]
  );

  return (
    <MediaPlayerTooltip shortcut="P" tooltip="Picture in picture">
      <Button
        aria-controls={context.mediaId}
        aria-label={isPictureInPicture ? "Exit pip" : "Enter pip"}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-pip"
        data-state={isPictureInPicture ? "on" : "off"}
        disabled={isDisabled}
        type="button"
        {...pipButtonProps}
        className={cn("size-8", className)}
        onClick={onPictureInPicture}
        size="icon"
        variant="ghost"
      >
        {isPictureInPicture ? (
          <PictureInPicture2Icon />
        ) : (
          <PictureInPictureIcon />
        )}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerCaptionsProps = React.ComponentProps<typeof Button>;

function MediaPlayerCaptions(props: MediaPlayerCaptionsProps) {
  const { children, className, disabled, ...captionsProps } = props;

  const context = useMediaPlayerContext("MediaPlayerCaptions");
  const dispatch = useMediaDispatch();
  const isSubtitlesActive = useMediaSelector(
    (state) => (state.mediaSubtitlesShowing ?? []).length > 0
  );

  const isDisabled = disabled || context.disabled;
  const onCaptionsToggle = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      dispatch({
        type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
      });
    },
    [dispatch, props.onClick]
  );

  return (
    <MediaPlayerTooltip shortcut="C" tooltip="Captions">
      <Button
        aria-controls={context.mediaId}
        aria-label={isSubtitlesActive ? "Disable captions" : "Enable captions"}
        aria-pressed={isSubtitlesActive}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-captions"
        data-state={isSubtitlesActive ? "on" : "off"}
        disabled={isDisabled}
        type="button"
        {...captionsProps}
        className={cn("size-8", className)}
        onClick={onCaptionsToggle}
        size="icon"
        variant="ghost"
      >
        {children ??
          (isSubtitlesActive ? <SubtitlesIcon /> : <CaptionsOffIcon />)}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerDownloadProps = React.ComponentProps<typeof Button>;

function MediaPlayerDownload(props: MediaPlayerDownloadProps) {
  const { children, className, disabled, ...downloadProps } = props;

  const context = useMediaPlayerContext("MediaPlayerDownload");

  const isDisabled = disabled || context.disabled;

  const onDownload = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(event);

      if (event.defaultPrevented) return;

      const mediaElement = context.mediaRef.current;

      if (!(mediaElement && mediaElement.currentSrc)) return;

      const link = document.createElement("a");
      link.href = mediaElement.currentSrc;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },
    [context.mediaRef, props.onClick]
  );

  return (
    <MediaPlayerTooltip shortcut="D" tooltip="Download">
      <Button
        aria-controls={context.mediaId}
        aria-label="Download"
        data-disabled={isDisabled ? "" : undefined}
        data-slot="media-player-download"
        disabled={isDisabled}
        type="button"
        {...downloadProps}
        className={cn("size-8", className)}
        onClick={onDownload}
        size="icon"
        variant="ghost"
      >
        {children ?? <DownloadIcon />}
      </Button>
    </MediaPlayerTooltip>
  );
}

type MediaPlayerSettingsProps = MediaPlayerPlaybackSpeedProps;

function MediaPlayerSettings(props: MediaPlayerSettingsProps) {
  const {
    open,
    defaultOpen,
    onOpenChange: onOpenChangeProp,
    sideOffset = FLOATING_MENU_SIDE_OFFSET,
    speeds = SPEEDS,
    asChild,
    modal = false,
    className,
    disabled,
    ...settingsProps
  } = props;

  const context = useMediaPlayerContext(SETTINGS_NAME);
  const store = useStoreContext(SETTINGS_NAME);
  const dispatch = useMediaDispatch();

  const mediaPlaybackRate = useMediaSelector(
    (state) => state.mediaPlaybackRate ?? 1
  );
  const mediaSubtitlesList = useMediaSelector(
    (state) => state.mediaSubtitlesList ?? []
  );
  const mediaSubtitlesShowing = useMediaSelector(
    (state) => state.mediaSubtitlesShowing ?? []
  );
  const mediaRenditionList = useMediaSelector(
    (state) => state.mediaRenditionList ?? []
  );
  const selectedRenditionId = useMediaSelector(
    (state) => state.mediaRenditionSelected
  );

  const isDisabled = disabled || context.disabled;
  const isSubtitlesActive = mediaSubtitlesShowing.length > 0;

  const onPlaybackRateChange = React.useCallback(
    (rate: number) => {
      dispatch({
        type: MediaActionTypes.MEDIA_PLAYBACK_RATE_REQUEST,
        detail: rate,
      });
    },
    [dispatch]
  );

  const onRenditionChange = React.useCallback(
    (renditionId: string) => {
      dispatch({
        type: MediaActionTypes.MEDIA_RENDITION_REQUEST,
        detail: renditionId === "auto" ? undefined : renditionId,
      });
    },
    [dispatch]
  );

  const onSubtitlesToggle = React.useCallback(() => {
    dispatch({
      type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
      detail: false,
    });
  }, [dispatch]);

  const onShowSubtitleTrack = React.useCallback(
    (subtitleTrack: (typeof mediaSubtitlesList)[number]) => {
      dispatch({
        type: MediaActionTypes.MEDIA_TOGGLE_SUBTITLES_REQUEST,
        detail: false,
      });
      dispatch({
        type: MediaActionTypes.MEDIA_SHOW_SUBTITLES_REQUEST,
        detail: subtitleTrack,
      });
    },
    [dispatch]
  );

  const selectedSubtitleLabel = React.useMemo(() => {
    if (!isSubtitlesActive) return "Off";
    if (mediaSubtitlesShowing.length > 0) {
      return mediaSubtitlesShowing[0]?.label ?? "On";
    }
    return "Off";
  }, [isSubtitlesActive, mediaSubtitlesShowing]);

  const selectedRenditionLabel = React.useMemo(() => {
    if (!selectedRenditionId) return "Auto";

    const currentRendition = mediaRenditionList?.find(
      (rendition) => rendition.id === selectedRenditionId
    );
    if (!currentRendition) return "Auto";

    if (currentRendition.height) return `${currentRendition.height}p`;
    if (currentRendition.width) return `${currentRendition.width}p`;
    return currentRendition.id ?? "Auto";
  }, [selectedRenditionId, mediaRenditionList]);

  const onOpenChange = React.useCallback(
    (open: boolean) => {
      store.setState("menuOpen", open);
      onOpenChangeProp?.(open);
    },
    [store.setState, onOpenChangeProp]
  );

  return (
    <DropdownMenu
      defaultOpen={defaultOpen}
      modal={modal}
      onOpenChange={onOpenChange}
      open={open}
    >
      <MediaPlayerTooltip tooltip="Settings">
        <DropdownMenuTrigger asChild>
          <Button
            aria-controls={context.mediaId}
            aria-label="Settings"
            data-disabled={isDisabled ? "" : undefined}
            data-slot="media-player-settings"
            disabled={isDisabled}
            type="button"
            {...settingsProps}
            className={cn(
              "size-8 aria-[expanded=true]:bg-accent/50",
              className
            )}
            size="icon"
            variant="ghost"
          >
            <SettingsIcon />
          </Button>
        </DropdownMenuTrigger>
      </MediaPlayerTooltip>
      <DropdownMenuContent
        align="end"
        className="w-56 data-[side=top]:mb-3.5"
        side="top"
        sideOffset={sideOffset}
      >
        <DropdownMenuLabel className="sr-only">Settings</DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">Speed</span>
            <Badge className="rounded-sm" variant="outline">
              {mediaPlaybackRate}x
            </Badge>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {speeds.map((speed) => (
              <DropdownMenuItem
                className="justify-between"
                key={speed}
                onSelect={() => onPlaybackRateChange(speed)}
              >
                {speed}x{mediaPlaybackRate === speed && <CheckIcon />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {context.isVideo && mediaRenditionList.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex-1">Quality</span>
              <Badge className="rounded-sm" variant="outline">
                {selectedRenditionLabel}
              </Badge>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                className="justify-between"
                onSelect={() => onRenditionChange("auto")}
              >
                Auto
                {!selectedRenditionId && <CheckIcon />}
              </DropdownMenuItem>
              {mediaRenditionList
                .slice()
                .sort((a, b) => {
                  const aHeight = a.height ?? 0;
                  const bHeight = b.height ?? 0;
                  return bHeight - aHeight;
                })
                .map((rendition) => {
                  const label = rendition.height
                    ? `${rendition.height}p`
                    : rendition.width
                    ? `${rendition.width}p`
                    : rendition.id ?? "Unknown";

                  const selected = rendition.id === selectedRenditionId;

                  return (
                    <DropdownMenuItem
                      className="justify-between"
                      key={rendition.id}
                      onSelect={() => onRenditionChange(rendition.id ?? "")}
                    >
                      {label}
                      {selected && <CheckIcon />}
                    </DropdownMenuItem>
                  );
                })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">Captions</span>
            <Badge className="rounded-sm" variant="outline">
              {selectedSubtitleLabel}
            </Badge>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              className="justify-between"
              onSelect={onSubtitlesToggle}
            >
              Off
              {!isSubtitlesActive && <CheckIcon />}
            </DropdownMenuItem>
            {mediaSubtitlesList.map((subtitleTrack) => {
              const isSelected = mediaSubtitlesShowing.some(
                (showingSubtitle) =>
                  showingSubtitle.label === subtitleTrack.label
              );
              return (
                <DropdownMenuItem
                  className="justify-between"
                  key={`${subtitleTrack.kind}-${subtitleTrack.label}-${subtitleTrack.language}`}
                  onSelect={() => onShowSubtitleTrack(subtitleTrack)}
                >
                  {subtitleTrack.label}
                  {isSelected && <CheckIcon />}
                </DropdownMenuItem>
              );
            })}
            {mediaSubtitlesList.length === 0 && (
              <DropdownMenuItem disabled>
                No captions available
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface MediaPlayerPortalProps {
  container?: Element | DocumentFragment | null;
  children?: React.ReactNode;
}

function MediaPlayerPortal(props: MediaPlayerPortalProps) {
  const { container: containerProp, children } = props;

  const context = useMediaPlayerContext("MediaPlayerPortal");
  const container = containerProp ?? context.portalContainer;

  if (!container) return null;

  return ReactDOM.createPortal(children, container);
}

interface MediaPlayerTooltipProps
  extends React.ComponentProps<typeof Tooltip>,
    Pick<React.ComponentProps<typeof TooltipContent>, "sideOffset"> {
  tooltip?: string;
  shortcut?: string | string[];
}

function MediaPlayerTooltip(props: MediaPlayerTooltipProps) {
  const {
    tooltip,
    shortcut,
    delayDuration,
    sideOffset,
    children,
    ...tooltipProps
  } = props;

  const context = useMediaPlayerContext("MediaPlayerTooltip");
  const tooltipDelayDuration = delayDuration ?? context.tooltipDelayDuration;
  const tooltipSideOffset = sideOffset ?? context.tooltipSideOffset;

  if (!(tooltip || shortcut) || context.withoutTooltip) return <>{children}</>;

  return (
    <Tooltip {...tooltipProps} delayDuration={tooltipDelayDuration}>
      <TooltipTrigger
        asChild
        className="text-foreground focus-visible:ring-ring/50"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        className="flex items-center gap-2 border bg-accent px-2 py-1 font-medium text-foreground data-[side=top]:mb-3.5 dark:bg-zinc-900 [&>span]:hidden"
        sideOffset={tooltipSideOffset}
      >
        <p>{tooltip}</p>
        {Array.isArray(shortcut) ? (
          <div className="flex items-center gap-1">
            {shortcut.map((shortcutKey) => (
              <kbd
                className="select-none rounded border bg-secondary px-1.5 py-0.5 font-mono text-[11.2px] text-foreground shadow-xs"
                key={shortcutKey}
              >
                <abbr className="no-underline" title={shortcutKey}>
                  {shortcutKey}
                </abbr>
              </kbd>
            ))}
          </div>
        ) : (
          shortcut && (
            <kbd
              className="select-none rounded border bg-secondary px-1.5 py-px font-mono text-[11.2px] text-foreground shadow-xs"
              key={shortcut}
            >
              <abbr className="no-underline" title={shortcut}>
                {shortcut}
              </abbr>
            </kbd>
          )
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export {
  MediaPlayerRoot as MediaPlayer,
  MediaPlayerVideo,
  MediaPlayerAudio,
  MediaPlayerControls,
  MediaPlayerControlsOverlay,
  MediaPlayerLoading,
  MediaPlayerError,
  MediaPlayerVolumeIndicator,
  MediaPlayerPlay,
  MediaPlayerSeekBackward,
  MediaPlayerSeekForward,
  MediaPlayerSeek,
  MediaPlayerVolume,
  MediaPlayerTime,
  MediaPlayerPlaybackSpeed,
  MediaPlayerLoop,
  MediaPlayerFullscreen,
  MediaPlayerPiP,
  MediaPlayerCaptions,
  MediaPlayerDownload,
  MediaPlayerSettings,
  MediaPlayerPortal,
  MediaPlayerTooltip,
  //
  MediaPlayerRoot as Root,
  MediaPlayerVideo as Video,
  MediaPlayerAudio as Audio,
  MediaPlayerControls as Controls,
  MediaPlayerControlsOverlay as ControlsOverlay,
  MediaPlayerLoading as Loading,
  MediaPlayerVolumeIndicator as VolumeIndicator,
  MediaPlayerError as Error,
  MediaPlayerPlay as Play,
  MediaPlayerSeekBackward as SeekBackward,
  MediaPlayerSeekForward as SeekForward,
  MediaPlayerSeek as Seek,
  MediaPlayerVolume as Volume,
  MediaPlayerTime as Time,
  MediaPlayerPlaybackSpeed as PlaybackSpeed,
  MediaPlayerLoop as Loop,
  MediaPlayerFullscreen as Fullscreen,
  MediaPlayerPiP as PiP,
  MediaPlayerCaptions as Captions,
  MediaPlayerDownload as Download,
  MediaPlayerSettings as Settings,
  MediaPlayerPortal as Portal,
  MediaPlayerTooltip as Tooltip,
  //
  useMediaSelector as useMediaPlayer,
  useStoreSelector as useMediaPlayerStore,
};
