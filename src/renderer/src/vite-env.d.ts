declare module '*?worker' {
  const workerFactory: new () => Worker
  export default workerFactory
}
