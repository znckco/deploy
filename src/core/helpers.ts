import * as FS from "fs";

export function quote(text: string): string {
  return JSON.stringify(text);
}

export class Exception extends Error {
  constructor(public readonly code: string, message: string = code) {
    super(message);
  }
}

export class FileNotFoundException extends Exception {
  constructor(public readonly fileName: string) {
    super("FileNotFound", `No such file ${quote(fileName)}`);
  }
}

export type DateString = string;

export function uuid<T extends string>(): T {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }) as T;
}

export function areObjectsEqual(a: any, b: any, depth: number = 0): boolean {
  if (typeof a !== typeof b) return false;
  const type = typeof a;
  if (type === "object") {
    if (a === null || b === null) {
      return a === b;
    }

    if (depth > 20) throw new Exception("PossibleCircularObject");

    if (Array.isArray(a) || Array.isArray(b)) {
      if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((_, index) => areObjectsEqual(a[index], b[index], depth + 1));
      }
      return false;
    }

    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => areObjectsEqual(a[key], b[key], depth + 1));
  }

  return a === b;
}

export function getCreatedAt(): DateString {
  return new Date().toISOString();
}

export async function importJSON<T>(configFile: string): Promise<T> {
  const contents = await FS.promises.readFile(configFile, "utf-8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Exception("InvalidJSONObject", error.message);
  }
}
