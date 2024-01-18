// let obj ={
//   name: 'Sanek',
//   age:14,
//   sayHI(){
//     console.log('hello');
//   }
// }
// console.log(JSON.parse(JSON.stringify(obj)));
// function newFunction() {
//   for (let i = 0; i < 10; i++) {
//     if (i == 3) {
//       continue;
//     }
//     console.log(i);

//   }
// }
// import os from "os";
// console.log('Платформа - ' + os.platform());
import express from "express";
let app = express()

app.get('/', function(req, res){
  res.send('<h1>Hello world</h1>')
});
app.get('/google/:search' ,function(req, res) {
  let search = req.params.search;
  res.redirect('http://google.com/search?q=' + search)
  
})
app.listen(3000, function() {
  console.log('Екземпляр запущено через порт 3000');
})