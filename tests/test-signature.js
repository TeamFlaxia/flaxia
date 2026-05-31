// Test the signature string from the logs
const signature = "ojxtNXxi4IpQgXWS6L2qIFpNDn93WsLlykDzm06qdannwta3Pj5+UFFUj3XRJEBJYQ1xLM5kRr4Ze7DcKhknT0v5GnSLg78TQHfsV5eizeItK/ntkcbkHpH0F8l0O8gLO1XT+mZ+fFfQoZ5c1p5C2lrIoQNc2cqjxiCAfi96a4rcpSBZfhj0T4nWvShLcp1Jllt6E+Paf08Hfu88MU0dMDaVUS2SIxuObAcHhndd0K9nawrd3zut88A2IOmqUQ34kNZ2nmWD1jtUYPC+OBcf+FU+hU/3ulwNA/9VWomWhuwCIWF/AyABU2E30Vi11AZsuh6fr1+P0mH1rC69Ex+BoQ=="

console.log('Signature length:', signature.length)
console.log('Signature % 4:', signature.length % 4)
console.log('Last 10 chars:', signature.substring(signature.length - 10))

try {
  const decoded = atob(signature)
  console.log('Decode successful, length:', decoded.length)
} catch (error) {
  console.error('Decode failed:', error.message)
  
  // Try with padding
  let padded = signature
  while (padded.length % 4 !== 0) {
    padded += '='
  }
  console.log('Padded length:', padded.length)
  
  try {
    const decoded = atob(padded)
    console.log('Padded decode successful, length:', decoded.length)
  } catch (error2) {
    console.error('Padded decode failed:', error2.message)
  }
}
