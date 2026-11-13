export interface Example {
  name: string;
  code: string;
}

export const EXAMPLES: Example[] = [
  {
    name: 'Bubble sort (buggy)',
    code: `// Bubble sort with a bug. Hit Run, then drag the timeline backward
// and watch \`arr\` to find the line where a value gets lost.
function bubbleSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length - i - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        arr[j] = arr[j + 1];
        arr[j + 1] = arr[j];
      }
    }
  }
  return arr;
}

const numbers = [5, 2, 9, 1, 7];
const sorted = bubbleSort(numbers);
console.log(sorted);
`,
  },
  {
    name: 'Fibonacci',
    code: `// Recursive Fibonacci. Step through to watch the call stack
// grow and unwind: each call gets its own \`n\`.
function fib(n) {
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

const result = fib(8);
console.log(result);
`,
  },
  {
    name: 'Binary search',
    code: `// Binary search over a sorted array. Watch \`low\`, \`high\` and
// \`mid\` close in on the target.
function binarySearch(sorted, target) {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] === target) {
      return mid;
    }
    if (sorted[mid] < target) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return -1;
}

const values = [2, 5, 8, 12, 16, 23, 38, 56, 72, 91];
const index = binarySearch(values, 23);
const missing = binarySearch(values, 7);
console.log(index, missing);
`,
  },
];
