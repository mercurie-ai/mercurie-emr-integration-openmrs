/**
 * Recursively converts a JSON object to a pretty-printed Markdown string.
 * @param data The JSON object to convert.
 * @param indent The current indentation level, used for nested elements.
 * @returns The Markdown-formatted string.
 */
export function jsonToMarkdown(data: any, indent = 0): string {
  const output: string[] = [];
  const indentStr = ' '.repeat(indent);

  for (const key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      const value = data[key];
      const header = indent > 0 ?
        `${indentStr}**${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}**`
      :
        `\n# ${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}\n`;

      // Handle different value types recursively
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          // Format arrays as unordered lists
          output.push(header);
          value.forEach(item => {
            if (typeof item === 'object' && item !== null) {
              // Handle arrays of objects by calling recursively
              output.push(jsonToMarkdown(item, indent + 2));
            } else {
              output.push(`${indentStr}  * ${item}`);
            }
          });
        } else {
          // Format nested objects with a new header and deeper indentation
          output.push(header);
          output.push(jsonToMarkdown(value, indent + 2));
        }
      } else {
        // Handle simple key-value pairs
        if (indent > 0) {
          output.push(`${header}: ${value}`)
        } else {
          output.push(`${header}${value}`)
        };
      }
    }
  }

  return output.join('\n');
}




//------ Convert keys of interface type to Title Case from snake_case -------------

// Using TypeScript's type mapping

// A utility type to capitalize the first letter of a string.
type Capitalize<S extends string> = S extends `${infer T}${infer U}` ? `${Uppercase<T>}${U}` : S;

// A utility type that converts a snake_case string to "Title Case".
type SnakeToTitleCase<S extends string> = S extends `${infer T}_${infer U}`
  ? `${Capitalize<T>} ${SnakeToTitleCase<U>}`
  : Capitalize<S>;

// A mapped type that applies the SnakeToTitleCase conversion to all keys of an object type.
export type KeysToTitleCase<T> = {
  [K in keyof T as SnakeToTitleCase<K & string>]: T[K];
};


// Runtime function to convert a string from "Title Case" to snake_case
function toSnakeCase(str: string): string {
  return str.replace(/\s+/g, '_').toLowerCase();
}


/**
 * An internal, recursive helper function that performs the key conversion.
 * It uses `any` to handle the recursive nature of transforming values that
 * can be objects, arrays, or primitives.
 */
function convertKeysRecursively(data: any): any {
  if (Array.isArray(data)) {
    // If the data is an array, map over it and recurse.
    return data.map(item => convertKeysRecursively(item));
  }

  if (data !== null && typeof data === 'object' && data.constructor === Object) {
    // If the data is a plain object, reduce it to a new object with converted keys.
    return Object.keys(data).reduce((acc, key) => {
      const newKey = toSnakeCase(key);
      const value = data[key];
      acc[newKey] = convertKeysRecursively(value); // Recurse on the value.
      return acc;
    }, {} as { [key: string]: any });
  }

  // If the data is a primitive or non-plain object (e.g., Date), return it as is.
  return data;
}


/**
 * A strongly-typed wrapper function that converts an object's keys from
 * "Title Case" to snake_case.
 */
export function convertKeysToSnakeCase<T extends object>(obj: KeysToTitleCase<T>): T {
  return convertKeysRecursively(obj) as T;
}