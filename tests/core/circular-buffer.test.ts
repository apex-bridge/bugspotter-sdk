import { describe, it, expect } from 'vitest';
import { CircularBuffer } from '@bugspotter/common';

describe('CircularBuffer', () => {
  describe('constructor', () => {
    it('should create an empty buffer with specified capacity', () => {
      const buffer = new CircularBuffer<number>(5);

      expect(buffer.size).toBe(0);
      expect(buffer.capacity).toBe(5);
      expect(buffer.isEmpty).toBe(true);
      expect(buffer.isFull).toBe(false);
    });

    it('should throw error for invalid maxSize', () => {
      expect(() => {
        return new CircularBuffer(0);
      }).toThrow('maxSize must be greater than 0');
      expect(() => {
        return new CircularBuffer(-1);
      }).toThrow('maxSize must be greater than 0');
    });
  });

  describe('add', () => {
    it('should add items to the buffer', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      expect(buffer.size).toBe(1);
      expect(buffer.getAll()).toEqual([1]);

      buffer.add(2);
      expect(buffer.size).toBe(2);
      expect(buffer.getAll()).toEqual([1, 2]);

      buffer.add(3);
      expect(buffer.size).toBe(3);
      expect(buffer.getAll()).toEqual([1, 2, 3]);
      expect(buffer.isFull).toBe(true);
    });

    it('should overwrite oldest item when buffer is full', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      buffer.add(2);
      buffer.add(3);
      expect(buffer.getAll()).toEqual([1, 2, 3]);

      // Should overwrite 1 with 4
      buffer.add(4);
      expect(buffer.getAll()).toEqual([2, 3, 4]);
      expect(buffer.size).toBe(3);

      // Should overwrite 2 with 5
      buffer.add(5);
      expect(buffer.getAll()).toEqual([3, 4, 5]);

      // Should overwrite 3 with 6
      buffer.add(6);
      expect(buffer.getAll()).toEqual([4, 5, 6]);
    });

    it('should handle objects as items', () => {
      interface Item {
        id: number;
        name: string;
      }

      const buffer = new CircularBuffer<Item>(2);

      buffer.add({ id: 1, name: 'first' });
      buffer.add({ id: 2, name: 'second' });
      expect(buffer.getAll()).toEqual([
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
      ]);

      buffer.add({ id: 3, name: 'third' });
      expect(buffer.getAll()).toEqual([
        { id: 2, name: 'second' },
        { id: 3, name: 'third' },
      ]);
    });
  });

  describe('getAll', () => {
    it('should return items in chronological order', () => {
      const buffer = new CircularBuffer<number>(5);

      buffer.add(1);
      buffer.add(2);
      buffer.add(3);

      const items = buffer.getAll();
      expect(items).toEqual([1, 2, 3]);
    });

    it('should return items in correct order after wrapping', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      buffer.add(2);
      buffer.add(3);
      buffer.add(4); // overwrites 1
      buffer.add(5); // overwrites 2

      const items = buffer.getAll();
      expect(items).toEqual([3, 4, 5]);
    });

    it('should return a copy, not a reference', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      buffer.add(2);

      const items1 = buffer.getAll();
      const items2 = buffer.getAll();

      expect(items1).toEqual(items2);
      expect(items1).not.toBe(items2); // Different array instances

      // Modifying returned array should not affect buffer
      items1.push(999);
      expect(buffer.getAll()).toEqual([1, 2]);
    });

    it('should return empty array for empty buffer', () => {
      const buffer = new CircularBuffer<number>(5);
      expect(buffer.getAll()).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should remove all items from buffer', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      buffer.add(2);
      buffer.add(3);
      expect(buffer.size).toBe(3);

      buffer.clear();
      expect(buffer.size).toBe(0);
      expect(buffer.isEmpty).toBe(true);
      expect(buffer.isFull).toBe(false);
      expect(buffer.getAll()).toEqual([]);
    });

    it('should allow adding items after clear', () => {
      const buffer = new CircularBuffer<number>(3);

      buffer.add(1);
      buffer.add(2);
      buffer.clear();

      buffer.add(10);
      buffer.add(20);

      expect(buffer.size).toBe(2);
      expect(buffer.getAll()).toEqual([10, 20]);
    });
  });

  describe('properties', () => {
    it('should correctly report isEmpty', () => {
      const buffer = new CircularBuffer<number>(3);

      expect(buffer.isEmpty).toBe(true);

      buffer.add(1);
      expect(buffer.isEmpty).toBe(false);

      buffer.clear();
      expect(buffer.isEmpty).toBe(true);
    });

    it('should correctly report isFull', () => {
      const buffer = new CircularBuffer<number>(2);

      expect(buffer.isFull).toBe(false);

      buffer.add(1);
      expect(buffer.isFull).toBe(false);

      buffer.add(2);
      expect(buffer.isFull).toBe(true);

      // Should still be full after overwriting
      buffer.add(3);
      expect(buffer.isFull).toBe(true);

      buffer.clear();
      expect(buffer.isFull).toBe(false);
    });

    it('should maintain constant capacity', () => {
      const buffer = new CircularBuffer<number>(5);

      expect(buffer.capacity).toBe(5);

      buffer.add(1);
      buffer.add(2);
      expect(buffer.capacity).toBe(5);

      buffer.clear();
      expect(buffer.capacity).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('should work with buffer of size 1', () => {
      const buffer = new CircularBuffer<string>(1);

      buffer.add('first');
      expect(buffer.getAll()).toEqual(['first']);

      buffer.add('second');
      expect(buffer.getAll()).toEqual(['second']);

      buffer.add('third');
      expect(buffer.getAll()).toEqual(['third']);
    });

    it('should handle rapid additions', () => {
      const buffer = new CircularBuffer<number>(10);

      for (let i = 0; i < 100; i++) {
        buffer.add(i);
      }

      expect(buffer.size).toBe(10);
      expect(buffer.getAll()).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
    });
  });
});
