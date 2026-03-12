import { EventEmitter } from 'node:events';
import type { EventMap } from './types.js';

/**
 * TypedEventBus - A type-safe wrapper around Node.js EventEmitter.
 *
 * Provides strongly-typed event emission and subscription for all system events.
 * Events are defined in EventMap type to ensure compile-time type safety.
 */
export class TypedEventBus extends EventEmitter {
  /**
   * Emit a typed event with payload.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    return super.emit(event, payload);
  }

  /**
   * Subscribe to a typed event.
   * Returns the listener instance for chaining.
   */
  on<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void
  ): this {
    return super.on(event, listener);
  }

  /**
   * Subscribe to a typed event once.
   * Listener is automatically removed after first emission.
   */
  once<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void
  ): this {
    return super.once(event, listener);
  }

  /**
   * Unsubscribe from a typed event.
   */
  off<K extends keyof EventMap>(
    event: K,
    listener: (payload: EventMap[K]) => void
  ): this {
    return super.off(event, listener);
  }
}

/**
 * Global event bus singleton.
 * All components should use this instance for event communication.
 */
export const eventBus = new TypedEventBus();
