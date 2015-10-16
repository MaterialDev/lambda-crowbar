var gulp = require('gulp');
var mocha = require('gulp-mocha');
var tsm = require('teamcity-service-messages');
var packageJson = require('./package.json');

gulp.task('default', ['test']);

gulp.task('test', function(){
  return gulp.src('test/**/*.js', {read: false})
    .pipe(mocha());
});

gulp.task('testTeamCity', function(){
  return gulp.src('test/**/*.js', {read: false})
    .pipe(mocha({reporter: 'mocha-teamcity-reporter'}));
});

gulp.task('setBuildNumber', function(){
  tsm.buildNumber(packageJson.version + '.{build.number}')
});